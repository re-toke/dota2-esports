// 全链路验证：详情页 enrichTeamLogos 后 upcoming 的 logo 字段
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
  const snap=require(path.join(ROOT,'utils/team-logo-local-data.js'));
  const nameById={}; Object.keys(snap.byId||{}).forEach(id=>{nameById[id]=snap.byId[id].name||snap.byId[id].tag;});
  const Module=require('module');
  const m=new Module(path.join(PAGE_DIR,'league-detail.js'),module);
  m.filename=path.join(PAGE_DIR,'league-detail.js'); m.paths=Module._nodeModulePaths(PAGE_DIR);
  global.Page=(d)=>{global.__pageDef=d;};
  global.wx={cloud:{callFunction(o){console.log('[wx.cloud.callFunction]',o&&o.data&&o.data.action);return Promise.reject(new Error('no cloud'));}},request(o){const u=o.url;console.log('[wx.request]',u.slice(0,60));return{abort(){}};},getStorageSync(){return null},setStorageSync(){},getSystemInfoSync(){return{}},canIUse(){return false}};
  m._compile(fs.readFileSync(path.join(PAGE_DIR,'league-detail.js'),'utf8'),m.filename);
  const pageDef=global.__pageDef;
  const sources=require(path.join(ROOT,'utils/sources.js'));
  const win={from:1786579200,to:1789171200};
  const filtered=sources.filterMatchesByWindow(raw,win);
  const LP=require(path.join(ROOT,'utils/liquipedia-parse.js'));
  const lpMatches=LP.parseScheduledMatches(j?j.parse.wikitext:'');
  const fakeThis={...pageDef,
    data:{...((pageDef.data)||{}),name:'EPL Masters II',leagueId:19944,metadata:{},pageSize:30,participantsList:[]},
    _teamIdNameMap:nameById,_logoQueryCache:{byId:{},byNormName:{}},_logoSnapChecked:false,
    allSeries:[],
    setData(o){Object.keys(o||{}).forEach(k=>{const parts=k.split(/[\.\[\]]/).filter(Boolean);let v=this.data;for(let i=0;i<parts.length-1;i++){const p=parts[i];v=v[p.startsWith('series')?parseInt(p.replace(/\D/g,'')):p]||{};}if(v&&parts.length)v[parts[parts.length-1]]=o[k];});}
  };
  const built=pageDef.buildSeriesFromSources.call(fakeThis,filtered,lpMatches,null);
  fakeThis.allSeries=built.allSeries;
  fakeThis.data.series=built.upcomingList.slice(0,10);  // 只把 upcoming 放进 series 让 enrichTeamLogos 可见
  fakeThis.data.upcomingGroups=[{dateKey:'test',list:built.upcomingList.slice(0,10)}];
  // 执行 enrichTeamLogos
  console.log('=== upcoming 前 10 场 enrichTeamLogos 前 ===');
  built.upcomingList.slice(0,6).forEach(s=>{
    console.log('  ', (s.radiantName||'').padEnd(22), 'vs', (s.direName||'').padEnd(22), '| id:'+s.radiantTeamId+'/'+s.direTeamId, '| logo:', (s.radiantLogo?'有':'空')+'/'+(s.direLogo?'有':'空'));
  });
  console.log('\n=== 开始 enrichTeamLogos ===');
  await pageDef.enrichTeamLogos.call(fakeThis);
  // 等 1s 让 Promise resolve
  await new Promise(r=>setTimeout(r,1500));
  console.log('\n=== enrichTeamLogos 后 fakeThis.data.series 中的 logo 状态 ===');
  (fakeThis.data.series||[]).slice(0,6).forEach(s=>{
    console.log('  ', (s.radiantName||'').padEnd(22), 'logo:', s.radiantLogo?('✅ '+s.radiantLogo.slice(0,45)):'❌ 空',
      '|', (s.direName||'').padEnd(22), 'logo:', s.direLogo?('✅ '+s.direLogo.slice(0,45)):'❌ 空');
  });
})();
// 追加：打印 nameLogoMap 的键和 series 的队名归一化键对比
