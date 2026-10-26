const http = require("node:http");

const port = Number(process.env.PORT || 3000);

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";

    request.on("data", (chunk) => {
      body += chunk;
    });

    request.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch (error) {
        reject(error);
      }
    });
  });
}

const server = http.createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/api/config") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      defaultModelId: "detail-v2",
      models: [
        {
          id: "detail-v2",
          name: "细节增强 V2",
          description: "用于对选区做材质、边缘、光影细化。",
          parameters: [
            { name: "strength", label: "细化强度", type: "number", default: 0.65, min: 0, max: 1, step: 0.05 },
            { name: "style", label: "风格", type: "select", default: "natural", options: ["natural", "sharp", "soft"] }
          ]
        },
        {
          id: "inpaint-fast",
          name: "快速局部重绘",
          description: "快速返回结果，适合草稿预览。",
          parameters: [
            { name: "strength", label: "重绘强度", type: "number", default: 0.5, min: 0, max: 1, step: 0.05 }
          ]
        }
      ]
    }));
    return;
  }

  if (request.method !== "POST" || request.url !== "/api/generate") {
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "Use GET /api/config or POST /api/generate" }));
    return;
  }

  try {
    const payload = await readJson(request);
    const imageBase64 = payload.input && payload.input.imageBase64;

    if (!imageBase64) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "Missing input.imageBase64" }));
      return;
    }

    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ imageBase64 }));
  } catch (error) {
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: error.message }));
  }
});

server.listen(port, () => {
  console.log(`Mock AIGC API listening at http://localhost:${port}/api/generate`);
});
