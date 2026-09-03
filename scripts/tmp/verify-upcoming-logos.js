// 真实链路验证：详情页 upcoming 队标的加载链路
const https=require('https'),zlib=require('zlib'),fs=require('fs');
const path=require('path');
const ROOT=path.join(__dirname,'..','..');
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
  console.log('LP parse 得到匹配:', lpMatches.length);
  // 过滤 upcoming 场
  const now=Math.floor(Date.now()/1000);
  const upcoming=lpMatches.filter(m=>m.startTime>now && m.team1Name && m.team2Name && !/TBD|TBA/i.test(m.team1Name+m.team2Name));
  console.log('未来 upcoming 场:', upcoming.length);
  // 取前 10 场验证 findTeamByName 是否能找到这些队
  const api=require(path.join(ROOT,'utils/api.js'));
  const norm=s=>String(s||'').toLowerCase().replace(/[^a-z0-9]/g,'');
  const uniqueTeams=new Set();
  upcoming.slice(0,15).forEach(m=>{uniqueTeams.add(m.team1Name);uniqueTeams.add(m.team2Name);});
  const teams=[...uniqueTeams].slice(0,12);
  console.log('前 12 支 upcoming 队伍:');
  for(const name of teams){
    const t=await api.findTeamByName(name).catch(()=>null);
    const logo=t&&(t.logo_url||'');
    console.log(' ', name.padEnd(28), '→ id:', (t&&t.team_id)||'未找到', '| logo:', logo?('✅ '+logo.slice(0,50)):'❌ 无');
  }
  // 对比：快照里有没有
  const snap=require(path.join(ROOT,'utils/team-logo-local-data.js'));
  const byName=snap.byName||{};
  console.log('\\n快照 byName 总数:', Object.keys(byName).length);
  teams.forEach(name=>{
    const n=norm(name);
    const hit=byName[n];
    console.log(' ', name.padEnd(28), '快照:', hit?('✅ '+hit.logo.slice(0,50)):'❌ 未命中');
  });
})();
