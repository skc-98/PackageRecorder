const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');const {execFileSync}=require('node:child_process');const {RecordingStore}=require('./storage');const {finalizeWebm}=require('./finalize-webm');
const ffmpeg=process.env.TEST_FFMPEG||'ffmpeg';const probe=process.env.TEST_FFPROBE||'ffprobe';
function inspect(file){return JSON.parse(execFileSync(probe,['-v','error','-show_format','-show_streams','-of','json',file]));}
function packetHashes(file){return JSON.parse(execFileSync(probe,['-v','error','-show_packets','-show_data_hash','sha256','-show_entries','packet=data_hash','-of','json',file])).packets.map(p=>p.data_hash);}
test('live WebM gains finite duration and seek index without changing compressed packets',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'recorder-seek-'));const input=path.join(root,'live.webm');const s=new RecordingStore((a,b)=>finalizeWebm(ffmpeg,a,b));
 try{
 execFileSync(ffmpeg,['-v','error','-f','lavfi','-i','testsrc2=size=160x90:rate=10','-t','24','-an','-c:v','libvpx','-g','20','-deadline','realtime','-f','webm','-live','1',input]);
 assert.equal(inspect(input).format.duration,undefined);
 await s.select(root);await s.prepare('2026-10-30');const start=await s.begin('seek-test');await s.append(new Uint8Array(await fs.readFile(input)));const saved=await s.finish();
 const info=inspect(saved.path);assert.ok(Math.abs(Number(info.format.duration)-24)<0.2);assert.equal(info.streams[0].codec_name,'vp8');assert.deepEqual(packetHashes(saved.path),packetHashes(input));
 const bytes=await fs.readFile(saved.path);assert.ok(bytes.includes(Buffer.from('1c53bb6b','hex')),'Cues index present');
 for(const seconds of [20,10,3]){const frame=execFileSync(ffmpeg,['-v','error','-ss',String(seconds),'-i',saved.path,'-frames:v','1','-f','image2pipe','-vcodec','png','pipe:1']);assert.ok(frame.length>100,'frame decoded after seek '+seconds);}
 await assert.rejects(fs.stat(start.partial));
 }finally{await s.abandon();await fs.rm(root,{recursive:true,force:true});}
});
test('failed finalization preserves original and clears busy state',async()=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),'recorder-failure-'));const s=new RecordingStore(async(a,b)=>{await fs.writeFile(b,'incomplete');throw Error('disk full');});try{await s.select(root);await s.prepare('2026-10-30');const start=await s.begin('safe');await s.append(new Uint8Array([1,2,3]));await assert.rejects(s.finish(),/원본 보존/);assert.deepEqual([...await fs.readFile(start.partial)],[1,2,3]);assert.equal(s.current,null);assert.deepEqual(await fs.readdir(s.directory),[path.basename(start.partial)]);}finally{await fs.rm(root,{recursive:true,force:true});}});
