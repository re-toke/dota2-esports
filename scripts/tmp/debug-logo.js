// 精确调试 enrichTeamLogos 的快照路径
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
  const j=await get('https://liquipedia.net/dota2/api.php?action=parse&page=EPL/Masters/2&prop=wikitext&format=json&formatversion=2').catch(()=>null);
  const LP=require(path.join(ROOT,'utils/liquipedia-parse.js'));
  const lpMatches=LP.parseScheduledMatches(j?j.parse.wikitext:'');
  const now=Math.floor(Date.now()/1000);
  const upcoming=lpMatches.filter(m=>m.startTime>now&&m.team1Name&&m.team2Name&&!/TBD|TBA/i.test(m.team1Name+m.team2Name));
  console.log('LP upcoming 场次:', upcoming.length);
  // 构造 allSeries（模拟 buildSeriesFromSources 的 liqSeries 输出形状）
  const allSeries=upcoming.map((m,i)=>({
    key:'liq-'+i, radiantTeamId:0, direTeamId:0,
    radiantName:m.team1Name, direName:m.team2Name,
    radiantLogo:'', direLogo:'',
  }));
  // 直接调用 _doEnrichTeamLogos（绕过 buildSeriesFromSources）
  const snap=require(path.join(ROOT,'utils/team-logo-local-data.js'));
  const Module=require('module');
  const m=new Module(path.join(PAGE_DIR,'league-detail.js'),module);
  m.filename=path.join(PAGE_DIR,'league-detail.js'); m.paths=Module._nodeModulePaths(PAGE_DIR);
  global.Page=(d)=>{global.__pageDef=d;};
  global.wx={cloud:{callFunction(){return Promise.reject(new Error('no cloud'));}},request(o){return{abort(){}};},getStorageSync(){return null},setStorageSync(){},getSystemInfoSync(){return{}},canIUse(){return false}};
  m._compile(fs.readFileSync(path.join(PAGE_DIR,'league-detail.js'),'utf8'),m.filename);
  const pageDef=global.__pageDef;
  const fakeThis={...pageDef,
    data:{series:allSeries.slice(0,10),participantsList:[]},
    _logoQueryCache:{byId:{},byNormName:{}},_logoSnapChecked:false,allSeries,
    setData(o){console.log('[setData] keys:',Object.keys(o||{}).length);Object.keys(o||{}).forEach(k=>{const ma=k.match(/series\[(\d+)\]\.(radiant|dire)Logo/);if(ma){const si=parseInt(ma[1]);allSeries[si]=allSeries[si]||{};allSeries[si][ma[2]+'Logo']=o[k];}});if(o.participantsList)this.data.participantsList=o.participantsList;}
  };
  console.log('调用 _doEnrichTeamLogos...');
  const result=await pageDef._doEnrichTeamLogos.call(fakeThis);
  await new Promise(r=>setTimeout(r,500));
  console.log('\\n结果:');
  allSeries.slice(0,6).forEach((s,i)=>console.log('  ['+i+']',s.radiantName.padEnd(22),'logo:',s.radiantLogo?('✅ '+s.radiantLogo.slice(0,40)):'❌','|',s.direName.padEnd(22),'logo:',s.direLogo?('✅ '+s.direLogo.slice(0,40)):'❌'));
})();
