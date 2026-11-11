// Local-only reporting; no network, external app or credential access.
const {reporters}=require('mocha');
const fs=require('fs'),path=require('path');
module.exports=class EvidenceReporter extends reporters.Spec {
 constructor(runner,options){
  super(runner,options);const tests=[];
  for(const state of ['pass','fail','pending'])runner.on(state,(test,error)=>tests.push({
   title:test.fullTitle(),file:path.relative(path.join(__dirname,'..'),test.file||''),state,durationMs:test.duration||0,
   ...(error?{error:String(error),stack:error.stack}:{}),
  }));
  runner.once('end',()=>fs.writeFileSync(path.join(__dirname,'../logs/results.json'),JSON.stringify({
   stats:runner.stats,network:'hardhat',chainId:31337,tests,
   note:'Approved arbitral appeal-reversal exemption is tested. DOCUMENTED TRUST LIMIT tests confirm remaining admin/Safe configuration limits, not fixes.'
  },null,2)+'\n'));
 }
};
