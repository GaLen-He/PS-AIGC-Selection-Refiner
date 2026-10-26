const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const api = require('../cep/AIGCSelectionRefiner/js/api-client');
const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'aigc-studio.txt'), 'utf8');

function catalog(source, ids) {
  assert.equal(typeof api.parseStudioCatalog, 'function', 'studio catalog parser must be available');
  return api.parseStudioCatalog(source, { groups: [{ model_type: 'image', models: ids }] });
}

test('studio parameters match supported models, defaults, and background labels', () => {
  const models = catalog(fixture, ['gpt-image-2', 'Midjourney-v7', 'MAI-Image-2.5', 'Banana-2', 'Banana-2', 'not-in-studio']);
  assert.equal(models.length, 4);
  const gpt = models.find(model => model.id === 'gpt-image-2');
  assert.deepEqual(gpt.parameters.map(parameter => parameter.name), ['Resolution', 'AspectRatio', 'Quality', 'Background']);
  assert.equal(gpt.parameters.find(parameter => parameter.name === 'Quality').default, 'high');
  assert.deepEqual(gpt.parameters.find(parameter => parameter.name === 'Background').options.at(-1), { value: 'transparent', label: '透明' });
  assert.deepEqual(models.find(model => model.id === 'Midjourney-v7').parameters.map(parameter => parameter.name), ['AspectRatio', 'Quality']);
  assert.deepEqual(models.find(model => model.id === 'MAI-Image-2.5').parameters, []);
});

test('catalog safely parses comments, escapes and trailing commas without executing source', () => {
  const changed = fixture.replace("label: 'Banana'", "label: 'Ban\\u0061na' /* literal only */");
  assert.equal(catalog(changed, ['Banana-2'])[0].name, 'Banana 2');
});

test('catalog rejects missing, executable, or prototype-mutating configuration', () => {
  for (const changed of [
    fixture.replace('const IMAGE_MODELS', 'const REMOVED_MODELS'),
    fixture.replace("label: 'Banana'", "label: (global.compromised = true)"),
    fixture.replace("label: 'Banana'", "__proto__: { compromised: true }"),
    fixture.replace("label: 'Banana'", "label: 'Banana' + 'injected'")
  ]) {
    assert.throws(() => catalog(changed, ['Banana-2']), /配置/);
  }
  assert.equal(global.compromised, undefined);
  assert.equal({}.compromised, undefined);
});

async function withGateway(handler, action) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await action(new api.GatewayClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'test-key' }));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('model discovery preserves authentication failures without guessing other endpoints', async () => {
  const paths = [];
  await withGateway((request, response) => {
    paths.push(request.url);
    response.writeHead(401);
    response.end('{"message":"invalid key"}');
  }, async client => {
    await assert.rejects(client.fetchModels(), /invalid key/);
    assert.deepEqual(paths, ['/my-models/api']);
  });
});

test('unexpected permission data is an error, not an empty authorized model list', async () => {
  await withGateway((request, response) => response.end('{"data":[]}'), async client => {
    await assert.rejects(client.fetchModels(), /模型列表.*格式/);
  });
});

test('external studio scripts are rejected before fetching them', async () => {
  const paths = [];
  await withGateway((request, response) => {
    paths.push(request.url);
    response.end(request.url === '/my-models/api'
      ? '{"groups":[{"model_type":"image","models":["Banana-2"]}]}'
      : '<script src="https://untrusted.invalid/aigc/assets/aigc.js"></script>');
  }, async client => {
    await assert.rejects(client.fetchModels(), /配置/);
    assert.deepEqual(paths, ['/my-models/api', '/aigc']);
  });
});

test('chosen studio model and OutputConfig survive submission, polling and image download', async () => {
  const os = require('node:os');
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRzQAAAAASUVORK5CYII=', 'base64');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aigc-flow-test-'));
  const destination = path.join(directory, 'result.png');
  const submissions = [];
  const authorizations = [];
  try {
    await withGateway((request, response) => {
      authorizations.push(request.headers.authorization);
      if (request.url === '/aigc/api/create-image') {
        let body = '';
        request.on('data', chunk => { body += chunk; });
        request.on('end', () => {
          submissions.push(JSON.parse(body));
          response.setHeader('x-trace-id', 'test-image-task');
          response.end('{}');
        });
      } else if (request.url.startsWith('/aigc/api/task-detail?trace_id=test-image-task&')) {
        response.end('{"status":"done"}');
      } else if (request.url === '/aigc/api/download_wm_url?trace_id=test-image-task&index=0&proxy=1') {
        response.setHeader('Content-Type', 'image/png');
        response.end(image);
      } else {
        response.writeHead(404);
        response.end('{}');
      }
    }, async client => {
      const model = catalog(fixture, ['Banana-2'])[0];
      const parameters = Object.fromEntries(model.parameters.map(parameter => [parameter.name, parameter.default]));
      parameters.AspectRatio = '4:3';
      const traceId = await client.createImage({ modelKey: model.id, prompt: '增强选区细节', imageUrl: 'https://cdn.example.test/selection.png', parameters });
      assert.equal(traceId, 'test-image-task');
      assert.equal(api.taskStatus(await client.getTask(traceId)), 'done');
      assert.equal(await client.downloadResult(traceId, destination), destination);
      assert.deepEqual(fs.readFileSync(destination), image);
      assert.deepEqual(submissions, [{
        ModelKey: 'Banana-2', Prompt: '增强选区细节',
        FileInfos: [{ Type: 'Url', Category: 'Image', Usage: 'Reference', Url: 'https://cdn.example.test/selection.png' }],
        OutputConfig: { Resolution: '1k', AspectRatio: '4:3' }
      }]);
      assert.deepEqual(authorizations, ['Bearer test-key', 'Bearer test-key', 'Bearer test-key']);
    });
  } finally {
    if (fs.existsSync(destination)) fs.unlinkSync(destination);
    fs.rmdirSync(directory);
  }
});
