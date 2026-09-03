// 更精细：手工触发 enrichTeamNames 完成后再跑 enrichTeamLogos
const https=require('https'),zlib=require('zlib'),fs=require('fs');
const path=require('path');
const ROOT=path.join(__dirname,'..','..');
const PAGE_DIR=path.join(ROOT,'subpackages/detail/league-detail');
const get=(url)=>new Promise((res,rej)=>{
  const req=https.get(url,{headers:{'Accept-Encoding':'gzip','User-Agent':'Mozilla/5.0'}},r=>{
    const chunks=[]; const stream=r.headers['content-encoding']==='gzip'?r.pipe(zlib.createGunzip()):r;
    stream.on('data',c=>chunks.push(c)); stream.on('end',()=>{try{res(JSON.parse(Buffer.concat(chunks).toString()))}catch(e){rej(e)}});
  }); req.on('error',rej); req.setTimeout(20000,()=>req.destroy(new Error('timeout')));
});
(async()=>{
  const [raw,j]=await Promise.all([
    get('https://api.opendota.com/api/leagues/19944/matches').catch(()=>[]),
    get('https://liquipedia.net/dota2/api.php?action=parse&page=EPL/Masters/2&prop=wikitext&format=json&formatversion=2').catch(()=>null)
  ]);
  const LP=require(path.join(ROOT,'utils/liquipedia-parse.js'));
  const lpMatches=LP.parseScheduledMatches(j?j.parse.wikitext:'');
  const Module=require('module');
  const m=new Module(path.join(PAGE_DIR,'league-detail.js'),module);
  m.filename=path.join(PAGE_DIR,'league-detail.js'); m.paths=Module._nodeModulePaths(PAGE_DIR);
  global.Page=(d)=>{global.__pageDef=d;};
  // 关键：wx.request 走直连（不走云函数），这样 findTeamByName 才能实际工作
  const https2=require('https');
  global.wx={
    cloud:{callFunction(){return Promise.reject(new Error('no cloud'));}},
    request(o){
      const url=o.url;
      return new Promise((resolve)=>{
        https2.get(url,{headers:{'Accept':'application/json','User-Agent':'Mozilla/5.0'}},r=>{
          let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{resolve({statusCode:r.statusCode,data:JSON.parse(d)})}catch(e){resolve({statusCode:500,data:null})}});
        }).on('error',()=>resolve({statusCode:500,data:null}));
      }).then(res=>{o.success&&o.success(res);return{abort(){}};});
    },
    getStorageSync(){return null},setStorageSync(){},getSystemInfoSync(){return{}},canIUse(){return false}
  };
  m._compile(fs.readFileSync(path.join(PAGE_DIR,'league-detail.js'),'utf8'),m.filename);
  const pageDef=global.__pageDef;
  const sources=require(path.join(ROOT,'utils/sources.js'));
  const win={from:1786579200,to:1789171200};
  const filtered=sources.filterMatchesByWindow(raw,win);
  const snap=require(path.join(ROOT,'utils/team-logo-local-data.js'));
  const nameById={}; Object.keys(snap.byId||{}).forEach(id=>{nameById[id]=snap.byId[id].name||id;});
  // 模拟真实 data
  const fakeData={name:'EPL Masters II',leagueId:19944,metadata:{},pageSize:30,participantsList:[],series:[]};
  const fakeThis={...pageDef,
    data:fakeData,_teamIdNameMap:nameById,
    _logoQueryCache:{byId:{},byNormName:{}},_logoSnapChecked:false,
    allSeries:[],
    setData(o){
      Object.keys(o||{}).forEach(k=>{
        if(k==='series'){fakeData.series=o[k];return;}
        const m=k.match(/^series\[(\d+)\]\.(.+)$/);
        if(m){const idx=parseInt(m[1]);fakeData.series[idx]=fakeData.series[idx]||{};fakeData.series[idx][m[2]]=o[k];return;}
        if(k==='participantsList'){fakeData.participantsList=o[k];return;}
        fakeData[k]=o[k];
      });
    }
  };
  const built=pageDef.buildSeriesFromSources.call(fakeThis,filtered,lpMatches,null);
  fakeThis.allSeries=built.allSeries;
  fakeData.series=built.allSeries.slice(0,30);
  // 关键：先跑 enrichTeamNames 完成（异步），再跑 enrichTeamLogos
  console.log('=== 步骤1: enrichTeamNames（队名补全）===');
  await pageDef.enrichTeamNames.call(fakeThis);
  console.log('enrichTeamNames 完成，series[0]:', fakeData.series[0] && fakeData.series[0].radiantName);
  console.log('\n=== 步骤2: enrichTeamLogos ===');
  await pageDef.enrichTeamLogos.call(fakeThis);
  await new Promise(r=>setTimeout(r,2500));
  console.log('enrichTeamLogos 完成');
  console.log('\n=== 最终结果（前 10 条）===');
  fakeData.series.slice(0,10).forEach((s,i)=>{
    console.log('  ['+i+']', (s.phase||'?').padEnd(8), (s.radiantName||'').padEnd(22)+' logo:', s.radiantLogo?('✅'+s.radiantLogo.slice(0,35)):'❌', '|', (s.direName||'').padEnd(22)+' logo:', s.direLogo?('✅'+s.direLogo.slice(0,35)):'❌');
  });
})();
