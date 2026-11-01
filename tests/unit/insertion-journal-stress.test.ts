/* @vitest-environment node */
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {InsertionJournal} from '@main/services/insertion-journal';

it('keeps 1,000 durable dispatch claims isolated under contention, restart and ambiguous settlement (no native insertion)',async()=>{
 const path=await mkdtemp(join(tmpdir(),'meluli-phase5-journal-'));
 try{
  const journal=new InsertionJournal(path);
  for(let block=0;block<100;block++)await Promise.all(Array.from({length:10},async(_,offset)=>{
   const index=block*10+offset,id=randomUUID(),transcript='transcript-'+index;
   const claims=await Promise.all([journal.claim(id,'pending-transcript'),new InsertionJournal(path).claim(id,'pending-transcript'),journal.claim(id,'pending-transcript')]);
   expect(claims.filter(Boolean)).toHaveLength(1);
   // If the other instance won, it cannot be recovered by resending. Its
   // reserved receipt remains a safe unknown; a new process must not settle it.
   if(!claims[0]&&!claims[2]){
    const receipt=JSON.parse(await readFile(join(path,id+'.json'),'utf8'));
    expect(receipt.state).toBe('dispatch_reserved');
    await expect(journal.settle(id,transcript,'confirmed')).rejects.toThrow();return;
   }
   const recovery={transcriptText:'שלום API '+index,audioPath:'/research/original-'+index+'.pcm',evidencePath:'/research/evidence-'+index+'.json',target:{pid:10+index,selectionStart:index%8}};
   await journal.attachRecovery(id,transcript,recovery);
   const state=index%3===0?'unresolved':index%3===1?'not_dispatched':'confirmed';
   const settlements=await Promise.allSettled([journal.settle(id,transcript,state),journal.settle(id,transcript,'confirmed')]);
   expect(settlements.filter(row=>row.status==='fulfilled')).toHaveLength(1);
   const receipt=JSON.parse(await readFile(join(path,id+'.json'),'utf8'));
   expect(receipt.state).toBe(state);expect(receipt.recovery).toEqual(recovery);expect(receipt.automaticRetryAllowed).toBe(false);
   expect(await new InsertionJournal(path).claim(id,transcript)).toBe(false);
  }));
 }finally{await rm(path,{recursive:true,force:true});}
},120000);
