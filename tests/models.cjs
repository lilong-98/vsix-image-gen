const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const script = path.resolve(process.argv[2] || path.join(__dirname, '../scripts/generate.js'));
const source = fs.readFileSync(script, 'utf8').replace(/main\(\);\s*$/, '');
const context = vm.createContext({
  require, Buffer, URL, setTimeout, __dirname: path.dirname(script),
  process: {
    env: { VSIX_IMAGE_RETRY_LIMIT: '1' },
    stdout: { write() {} }, stderr: { write() {} },
    cwd: () => process.cwd(), exit(code) { throw new Error(`exit:${code}`); },
  },
});
vm.runInContext(source, context);
const run = code => vm.runInContext(code, context);

async function main() {
  assert.equal(run("parseArgs(['--prompt','test']).model"), 'gpt-image-2');
  for (const model of ['gpt-image-2', 'gpt-image-2.5-sunburst']) {
    context.selectedModel = model;
    await run(`(async () => {
      const args = parseArgs(['--model', selectedModel, '--prompt', 'test']);
      const local = {jsonValue:'data:image/png;base64,AA==', multipartFile:{filename:'ref.png',mimeType:'image/png',buffer:Buffer.from([0])}};
      const remote = {jsonValue:'https://example.com/ref.png', multipartFile:null};
      globalThis.calls = [];
      submitImageRequest = async (base,key,endpoint,body) => {
        calls.push({endpoint,body});
        return {status:200,data:{data:[{b64_json:'AA=='}]}};
      };
      submitMultipartImageRequest = async (base,key,endpoint,body) => {
        calls.push({endpoint,body});
        return {status:200,data:{data:[{b64_json:'AA=='}]}};
      };
      await submitWithEndpointFallback('https://example.invalid/v1','test-key',args,[],'1024x1024');
      if (calls[0].endpoint !== '/images/generations' || calls[0].body.model !== selectedModel) throw Error('generation model lost');
      calls.length = 0;
      await submitWithEndpointFallback('https://example.invalid/v1','test-key',args,[local],'1024x1024');
      if (calls[0].endpoint !== '/images/edits' || calls[0].body.fields.model !== selectedModel || calls[0].body.files.length !== 1) throw Error('multipart edit lost model or image');
      calls.length = 0;
      await submitWithEndpointFallback('https://example.invalid/v1','test-key',args,[local,remote],'1024x1024');
      if (calls.length !== 1 || calls[0].body.images.length !== 2 || calls[0].body.model !== selectedModel) throw Error('mixed references lost');
      calls.length = 0;
      submitImageRequest = async (base,key,endpoint,body) => {
        calls.push({endpoint,body});
        return {status:502,data:{error:{message:'upstream unavailable'}}};
      };
      const failed = await submitWithEndpointFallback('https://example.invalid/v1','test-key',args,[remote],'3840x2160');
      if (failed.response.status !== 502 || calls.length !== 2) throw Error('unexpected retry or success');
      for (const call of calls) {
        if (call.body.model !== selectedModel || call.body.size !== '3840x2160') throw Error('model or size changed');
        if (!call.body.images && !call.body.image) throw Error('reference dropped during fallback');
      }
    })()`);
  }
  assert.throws(() => run("parseArgs(['--model','gpt-image-2.5-flare','--prompt','test'])"), /exit:1/);
  assert.equal(run("pickImageOutput({data:[{b64_json:'AA=='}]})"), 'data:image/png;base64,AA==');
  assert.equal(run("pickImageOutput({data:[{url:'https://example.com/out.png'}]})"), 'https://example.com/out.png');
  console.log('PASS: default compatibility, Sunburst generation and edits, mixed references, failure preservation, Flare rejection, output formats');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
