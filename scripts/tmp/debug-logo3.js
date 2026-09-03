// 加日志跟踪 enrichTeamLogos 内部 Promise.all 的 reject 情况
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
  const https2=require('https');
  let requestCount=0;
  global.wx={
    cloud:{callFunction(){return Promise.reject(new Error('no cloud'));}},
    request(o){
      requestCount++;
      const rc=requestCount;
      const url=o.url;
      console.log('[wx.request #'+rc+']', url.slice(0,70));
      return new Promise((resolve)=>{
        const r=https2.get(url,{headers:{'Accept':'application/json','User-Agent':'Mozilla/5.0'},timeout:8000},res=>{
          let d='';res.on('data',c=>d+=c);res.on('end',()=>{try{console.log('[wx.request #'+rc+' 返回]',res.statusCode,'len=',d.length);resolve({statusCode:res.statusCode,data:JSON.parse(d)})}catch(e){console.log('[wx.request #'+rc+' 解析失败]');resolve({statusCode:500,data:null})}});
        });
        r.on('error',e=>{console.log('[wx.request #'+rc+' error]',e.message);resolve({statusCode:500,data:null})});
        r.on('timeout',()=>{console.log('[wx.request #'+rc+' timeout]');r.destroy();resolve({statusCode:500,data:null});});
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
  const fakeData={name:'EPL Masters II',leagueId:19944,metadata:{},pageSize:30,participantsList:[],series:[]};
  const fakeThis={...pageDef,data:fakeData,_teamIdNameMap:nameById,_logoQueryCache:{byId:{},byNormName:{}},_logoSnapChecked:false,allSeries:[],
    setData(o){Object.keys(o||{}).forEach(k=>{if(k==='series'){fakeData.series=o[k];return;}const mm=k.match(/^series\[(\d+)\]\.(.+)$/);if(mm){const idx=parseInt(mm[1]);fakeData.series[idx]=fakeData.series[idx]||{};fakeData.series[idx][mm[2]]=o[k];return;}if(k==='participantsList'){fakeData.participantsList=o[k];return;}fakeData[k]=o[k];});}
  };
  const built=pageDef.buildSeriesFromSources.call(fakeThis,filtered,lpMatches,null);
  fakeThis.allSeries=built.allSeries;
  fakeData.series=built.allSeries.slice(0,30);
  console.log('开始 enrichTeamLogos，series 总数:', fakeData.series.length, '| allSeries:', fakeThis.allSeries.length);
  // 注入打点
  const orig = pageDef._doEnrichTeamLogos;
  pageDef._doEnrichTeamLogos = function() {
    console.log('[_doEnrichTeamLogos] 进入');
    const ret = orig.call(this);
    if (ret && ret.then) {
      ret.then(() => console.log('[_doEnrichTeamLogos] Promise resolve 成功'), 
              (e) => console.log('[_doEnrichTeamLogos] Promise REJECT:', e && e.message));
    } else {
      console.log('[_doEnrichTeamLogos] 同步返回:', typeof ret);
    }
    return ret;
  };
  await pageDef.enrichTeamLogos.call(fakeThis);
  await new Promise(r=>setTimeout(r,5000));
  console.log('\n=== 最终状态（upcoming 前 8 条）===');
  fakeData.series.slice(0,8).forEach((s,i)=>{
    console.log('  ['+i+']', (s.phase||'?').padEnd(8), (s.radiantName||'').padEnd(20)+' logo:', s.radiantLogo?'✅':'❌', '|', (s.direName||'').padEnd(20)+' logo:', s.direLogo?'✅':'❌');
  });
})();
