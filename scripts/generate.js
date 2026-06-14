#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const https = require("https");
const { spawnSync } = require("child_process");

const HOME_DIR = process.env.HOME || process.env.USERPROFILE || "";
const CONFIG_PATH = path.join(HOME_DIR, ".vsix", "config.json");
const API_BASE = process.env.VSIX_API_BASE || "https://vsix.cc/v1";
const SUPPORTED_SIZES = [
  "1024x1024",
  "1024x1536",
  "1536x1024",
  "768x768",
  "768x1152",
  "1152x768",
  "1536x864",
  "864x1536",
  "1920x1080",
  "1080x1920",
  "2048x2048",
  "3840x2160",
  "2160x3840",
  "2160x2160",
  "auto",
];
const SIZE_ALIASES = {
  "1:1": "1024x1024",
  "3:4": "1024x1536",
  "4:3": "1536x1024",
  "16:9": "1536x864",
  "9:16": "864x1536",
  square: "1024x1024",
  portrait: "1024x1536",
  landscape: "1536x1024",
  wide: "1536x864",
  vertical: "864x1536",
  "2k": "1920x1080",
  "2k-landscape": "1920x1080",
  "2k-portrait": "1080x1920",
  "4k": "3840x2160",
  "4k-landscape": "3840x2160",
  "4k-portrait": "2160x3840",
  "4k-square": "2160x2160",
};
const FALLBACK_SIZES = {
  "3840x2160": "1920x1080",
  "2160x3840": "1080x1920",
  "2160x2160": "1024x1024",
  "2048x2048": "1024x1024",
  "1920x1080": "1536x864",
  "1080x1920": "864x1536",
  "1536x1024": "1152x768",
  "1024x1536": "768x1152",
  "1024x1024": "768x768",
};
const ENDPOINT_RETRY_LIMIT = Number.parseInt(
  process.env.VSIX_IMAGE_RETRY_LIMIT || "4",
  10
);
const ENDPOINT_RETRY_BASE_DELAY_MS = Number.parseInt(
  process.env.VSIX_IMAGE_RETRY_BASE_DELAY_MS || "2500",
  10
);
const MIME_BY_EXT = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

function log(message) {
  process.stderr.write(`${message}\n`);
}

function fail(message) {
  log(message);
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printHelp() {
  log("Usage:");
  log('  node generate.js --prompt "Describe the image" [--size 1024x1024] [--image-url URL_OR_FILE] [--out output.png]');
  log("");
  log("Supported sizes:");
  log(`  ${SUPPORTED_SIZES.join(", ")}`);
  log("Aliases:");
  log("  1:1, 3:4, 4:3, square, portrait, landscape");
  log("  16:9, 9:16, wide, vertical, 2k, 2k-landscape, 2k-portrait");
  log("  4k, 4k-landscape, 4k-portrait, 4k-square");
}

function expandHome(inputPath) {
  if (!inputPath) {
    return inputPath;
  }
  if (inputPath === "~") {
    return HOME_DIR;
  }
  if (inputPath.startsWith("~/")) {
    return path.join(HOME_DIR, inputPath.slice(2));
  }
  return inputPath;
}

function loadApiKey() {
  if (process.env.VSIX_API_KEY) {
    return process.env.VSIX_API_KEY;
  }

  if (!fs.existsSync(CONFIG_PATH)) {
    fail(
      `Missing VSIX API key. Set VSIX_API_KEY or create ${CONFIG_PATH} with {"api_key":"YOUR_KEY"}.`
    );
  }

  let config;
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch (error) {
    fail(`Failed to parse ${CONFIG_PATH}: ${error.message}`);
  }

  if (!config.api_key || config.api_key === "YOUR_KEY") {
    fail(`Please update ${CONFIG_PATH} with a real VSIX API key.`);
  }

  return config.api_key;
}

function normalizeSize(rawSize) {
  const input = (rawSize || "1024x1024").trim().toLowerCase();
  const normalized = SIZE_ALIASES[input] || input;

  if (!SUPPORTED_SIZES.includes(normalized)) {
    fail(
      `Unsupported size "${rawSize}". Use one of: ${SUPPORTED_SIZES.join(", ")} or aliases ${Object.keys(
        SIZE_ALIASES
      ).join(", ")}.`
    );
  }

  return normalized;
}

function parseSize(size) {
  const match = /^(\d+)x(\d+)$/.exec(size || "");
  if (!match) {
    return null;
  }

  return {
    width: Number(match[1]),
    height: Number(match[2]),
  };
}

function parseArgs(argv) {
  const parsed = {
    prompt: "",
    size: "1024x1024",
    imageUrls: [],
    out: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    switch (arg) {
      case "--prompt":
        parsed.prompt = argv[index + 1] || "";
        index += 1;
        break;
      case "--size":
        parsed.size = argv[index + 1] || "";
        index += 1;
        break;
      case "--image-url":
        parsed.imageUrls.push(argv[index + 1] || "");
        index += 1;
        break;
      case "--out":
        parsed.out = argv[index + 1] || "";
        index += 1;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;
      default:
        fail(`Unknown argument: ${arg}`);
    }
  }

  if (!parsed.prompt) {
    printHelp();
    process.exit(1);
  }

  parsed.size = normalizeSize(parsed.size);
  parsed.imageUrls = parsed.imageUrls.filter(Boolean);
  return parsed;
}

function getMimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const mimeType = MIME_BY_EXT[extension];

  if (!mimeType) {
    fail(
      `Unsupported local image type "${extension || "unknown"}". Supported: ${Object.keys(
        MIME_BY_EXT
      ).join(", ")}.`
    );
  }

  return mimeType;
}

function isRemoteUrl(value) {
  return /^https?:\/\//i.test(value);
}

function isDataUri(value) {
  return /^data:/i.test(value);
}

function resolveLocalFile(value) {
  const expanded = expandHome(value);
  if (path.isAbsolute(expanded)) {
    return expanded;
  }
  return path.resolve(process.cwd(), expanded);
}

function normalizeImageInput(value) {
  if (isRemoteUrl(value) || isDataUri(value)) {
    return {
      jsonValue: value,
      multipartFile: isDataUri(value) ? dataUriToMultipartFile(value) : null,
    };
  }

  const filePath = resolveLocalFile(value);
  if (!fs.existsSync(filePath)) {
    fail(`Reference image not found: ${value}`);
  }

  const mimeType = getMimeType(filePath);
  const fileBuffer = fs.readFileSync(filePath);
  return {
    jsonValue: `data:${mimeType};base64,${fileBuffer.toString("base64")}`,
    multipartFile: {
      filename: path.basename(filePath),
      mimeType,
      buffer: fileBuffer,
    },
  };
}

function requestJson(urlString, apiKey, body) {
  const url = new URL(urlString);

  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        hostname: url.hostname,
        port: 443,
        path: `${url.pathname}${url.search}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");

          try {
            resolve({
              status: response.statusCode || 0,
              data: JSON.parse(raw),
            });
          } catch {
            resolve({
              status: response.statusCode || 0,
              data: raw,
            });
          }
        });
      }
    );

    request.on("error", reject);
    request.write(JSON.stringify(body));
    request.end();
  });
}

function dataUriToMultipartFile(dataUri) {
  const match = dataUri.match(/^data:([^;]+);base64,(.+)$/s);
  if (!match) {
    return null;
  }

  const mimeType = match[1];
  const extension = mimeType.split("/")[1] || "png";
  return {
    filename: `reference.${extension}`,
    mimeType,
    buffer: Buffer.from(match[2], "base64"),
  };
}

function requestMultipart(urlString, apiKey, fields, files) {
  const url = new URL(urlString);
  const boundary = `----vsix-image-gen-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}`;
  const chunks = [];

  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    chunks.push(
      Buffer.from(`Content-Disposition: form-data; name="${name}"\r\n\r\n`)
    );
    chunks.push(Buffer.from(`${value}\r\n`));
  }

  for (const file of files) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    chunks.push(
      Buffer.from(
        `Content-Disposition: form-data; name="image"; filename="${file.filename}"\r\n`
      )
    );
    chunks.push(Buffer.from(`Content-Type: ${file.mimeType}\r\n\r\n`));
    chunks.push(file.buffer);
    chunks.push(Buffer.from("\r\n"));
  }

  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  const body = Buffer.concat(chunks);

  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        hostname: url.hostname,
        port: 443,
        path: `${url.pathname}${url.search}`,
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": body.length,
        },
      },
      (response) => {
        const responseChunks = [];
        response.on("data", (chunk) => responseChunks.push(chunk));
        response.on("end", () => {
          const raw = Buffer.concat(responseChunks).toString("utf8");

          try {
            resolve({
              status: response.statusCode || 0,
              data: JSON.parse(raw),
            });
          } catch {
            resolve({
              status: response.statusCode || 0,
              data: raw,
            });
          }
        });
      }
    );

    request.on("error", reject);
    request.write(body);
    request.end();
  });
}

function downloadFile(urlString, outputPath) {
  const url = new URL(urlString);
  const filePath = path.resolve(outputPath);

  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const file = fs.createWriteStream(filePath);
    const request = https.get(url, (response) => {
      if ((response.statusCode || 0) >= 400) {
        file.close(() => fs.rmSync(filePath, { force: true }));
        reject(new Error(`Image download returned ${response.statusCode}`));
        return;
      }

      response.pipe(file);
      file.on("finish", () => {
        file.close(() => resolve(filePath));
      });
    });

    request.on("error", (error) => {
      file.close(() => fs.rmSync(filePath, { force: true }));
      reject(error);
    });
  });
}

function pickImageOutput(responseData) {
  const item = responseData && responseData.data && responseData.data[0];
  if (!item) {
    return null;
  }

  if (item.url) {
    return item.url;
  }

  if (item.b64_json) {
    return `data:image/png;base64,${item.b64_json}`;
  }

  return null;
}

function responseErrorMessage(response) {
  if (
    response.data &&
    response.data.error &&
    response.data.error.message
  ) {
    return response.data.error.message;
  }

  if (typeof response.data === "string") {
    return response.data;
  }

  return JSON.stringify(response.data);
}

function isRetryableUpstreamError(response) {
  const message = responseErrorMessage(response).toLowerCase();
  return (
    [502, 503, 504, 524].includes(response.status) ||
    message.includes("upstream") ||
    message.includes("timeout") ||
    message.includes("a timeout occurred") ||
    message.includes("cloudflare") ||
    message.includes("tls") ||
    message.includes("ssl") ||
    message.includes("socket") ||
    message.includes("econnreset") ||
    message.includes("bad record mac")
  );
}

function saveDataUri(dataUri, outputPath) {
  const match = dataUri.match(/^data:([^;]+);base64,(.+)$/s);
  if (!match) {
    fail("The API returned a data URI, but it was not a base64 image payload.");
  }

  const filePath = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.from(match[2], "base64"));
  return filePath;
}

function resizeImage(inputPath, outputPath, targetSize) {
  const size = parseSize(targetSize);
  if (!size) {
    return inputPath;
  }

  const script = [
    "from pathlib import Path",
    "from PIL import Image",
    "import sys",
    "src = Path(sys.argv[1])",
    "dst = Path(sys.argv[2])",
    "width = int(sys.argv[3])",
    "height = int(sys.argv[4])",
    "img = Image.open(src).convert('RGB')",
    "img = img.resize((width, height), Image.Resampling.LANCZOS)",
    "dst.parent.mkdir(parents=True, exist_ok=True)",
    "img.save(dst, 'PNG', optimize=True)",
  ].join("\n");

  const result = spawnSync(
    "python3",
    ["-c", script, inputPath, outputPath, String(size.width), String(size.height)],
    { encoding: "utf8" }
  );

  if (result.status !== 0) {
    fail(
      `Fallback resize failed. Install Pillow for Python or use a smaller native size. ${result.stderr || result.stdout}`
    );
  }

  return path.resolve(outputPath);
}

async function persistOutput(output, outputPath) {
  if (output.startsWith("data:image/")) {
    return saveDataUri(output, outputPath);
  }

  if (isRemoteUrl(output)) {
    return downloadFile(output, outputPath);
  }

  return null;
}

function buildGenerationRequestBody(args, normalizedImages, size) {
  const requestBody = {
    model: "gpt-image-2",
    prompt: args.prompt,
    n: 1,
    size,
  };
  const imageValues = normalizedImages.map((image) => image.jsonValue);

  if (imageValues.length === 1) {
    requestBody.image = imageValues[0];
  } else if (imageValues.length > 1) {
    requestBody.image = imageValues;
  }

  return requestBody;
}

function buildTextOnlyGenerationRequestBody(args, size) {
  return {
    model: "gpt-image-2",
    prompt: args.prompt,
    n: 1,
    size,
  };
}

function buildEditRequestBody(args, normalizedImages, size) {
  return {
    model: "gpt-image-2",
    prompt: args.prompt,
    n: 1,
    size,
    images: normalizedImages.map((image) => ({ image_url: image.jsonValue })),
  };
}

function buildMultipartEditRequest(args, normalizedImages, size) {
  const files = normalizedImages
    .map((image) => image.multipartFile)
    .filter(Boolean);

  if (files.length === 0) {
    return null;
  }

  return {
    fields: {
      model: "gpt-image-2",
      prompt: args.prompt,
      n: "1",
      size,
    },
    files,
  };
}

async function submitImageRequest(apiKey, endpoint, requestBody) {
  try {
    return await requestJson(`${API_BASE}${endpoint}`, apiKey, requestBody);
  } catch (error) {
    return {
      status: 0,
      data: {
        error: {
          message: error.message,
          type: "network_error",
        },
      },
    };
  }
}

async function submitMultipartImageRequest(apiKey, endpoint, requestParts) {
  try {
    return await requestMultipart(
      `${API_BASE}${endpoint}`,
      apiKey,
      requestParts.fields,
      requestParts.files
    );
  } catch (error) {
    return {
      status: 0,
      data: {
        error: {
          message: error.message,
          type: "network_error",
        },
      },
    };
  }
}

async function submitWithRetry(apiKey, endpoint, requestBody, label) {
  let response;

  for (let attempt = 1; attempt <= ENDPOINT_RETRY_LIMIT; attempt += 1) {
    response = await submitImageRequest(apiKey, endpoint, requestBody);

    if (response.status === 200 || !isRetryableUpstreamError(response)) {
      return response;
    }

    if (attempt < ENDPOINT_RETRY_LIMIT) {
      const delay = ENDPOINT_RETRY_BASE_DELAY_MS * attempt;
      log(
        `${label} attempt ${attempt}/${ENDPOINT_RETRY_LIMIT} returned ${response.status || "network"} (${responseErrorMessage(response)}). Retrying in ${delay}ms...`
      );
      await sleep(delay);
    }
  }

  return response;
}

async function submitMultipartWithRetry(apiKey, endpoint, requestParts, label) {
  let response;

  for (let attempt = 1; attempt <= ENDPOINT_RETRY_LIMIT; attempt += 1) {
    response = await submitMultipartImageRequest(apiKey, endpoint, requestParts);

    if (response.status === 200 || !isRetryableUpstreamError(response)) {
      return response;
    }

    if (attempt < ENDPOINT_RETRY_LIMIT) {
      const delay = ENDPOINT_RETRY_BASE_DELAY_MS * attempt;
      log(
        `${label} attempt ${attempt}/${ENDPOINT_RETRY_LIMIT} returned ${response.status || "network"} (${responseErrorMessage(response)}). Retrying in ${delay}ms...`
      );
      await sleep(delay);
    }
  }

  return response;
}

function shouldTryMultipartEdit(response) {
  const message = responseErrorMessage(response).toLowerCase();
  return (
    response.status === 400 ||
    response.status === 422 ||
    isRetryableUpstreamError(response) ||
    message.includes("openai_error")
  );
}

async function submitWithEndpointFallback(apiKey, args, normalizedImages, size) {
  if (normalizedImages.length === 0) {
    return {
      endpoint: "/images/generations",
      response: await submitWithRetry(
        apiKey,
        "/images/generations",
        buildGenerationRequestBody(args, normalizedImages, size),
        `VSIX generations ${size}`
      ),
    };
  }

  let response = await submitWithRetry(
    apiKey,
    "/images/edits",
    buildEditRequestBody(args, normalizedImages, size),
    `VSIX edits ${size}`
  );

  if (response.status === 200) {
    return { endpoint: "/images/edits", response };
  }

  const multipartRequest = buildMultipartEditRequest(args, normalizedImages, size);
  if (multipartRequest && shouldTryMultipartEdit(response)) {
    log(
      `VSIX edits JSON returned ${response.status} (${responseErrorMessage(response)}). Retrying with multipart image upload...`
    );
    response = await submitMultipartWithRetry(
      apiKey,
      "/images/edits",
      multipartRequest,
      `VSIX edits multipart ${size}`
    );

    if (response.status === 200) {
      return { endpoint: "/images/edits", response };
    }
  }

  if (isRetryableUpstreamError(response)) {
    log(
      `VSIX edits returned ${response.status} (${responseErrorMessage(response)}). Falling back to generations image input...`
    );
    response = await submitWithRetry(
      apiKey,
      "/images/generations",
      buildGenerationRequestBody(args, normalizedImages, size),
      `VSIX generations image input ${size}`
    );
    return { endpoint: "/images/generations", response };
  }

  return { endpoint: "/images/edits", response };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = loadApiKey();
  const normalizedImages = args.imageUrls.map(normalizeImageInput);

  log(`Prompt: ${args.prompt}`);
  log(`Size: ${args.size}`);
  if (args.out) {
    log(`Output file: ${args.out}`);
  }
  if (normalizedImages.length > 0) {
    log(`Reference images: ${normalizedImages.length}`);
  }
  const initialEndpoint = normalizedImages.length > 0 ? "/images/edits" : "/images/generations";
  log(`Requesting image generation from VSIX (${initialEndpoint})...`);
  let result = await submitWithEndpointFallback(
    apiKey,
    args,
    normalizedImages,
    args.size
  );
  let response = result.response;
  let generatedSize = args.size;
  let needsResize = false;

  if (response.status !== 200 && isRetryableUpstreamError(response) && FALLBACK_SIZES[args.size]) {
    generatedSize = FALLBACK_SIZES[args.size];
    needsResize = Boolean(args.out && parseSize(args.size));
    log(
      `VSIX returned ${response.status} (${responseErrorMessage(response)}). Retrying at ${generatedSize}${needsResize ? `, then resizing to ${args.size}` : ""}...`
    );
    result = await submitWithEndpointFallback(
      apiKey,
      args,
      normalizedImages,
      generatedSize
    );
    response = result.response;
  }

  if (response.status !== 200 && isRetryableUpstreamError(response) && normalizedImages.length > 0) {
    log(
      `Reference-image paths failed (${response.status}: ${responseErrorMessage(response)}). Falling back to text-only generation...`
    );
    generatedSize = FALLBACK_SIZES[generatedSize] || generatedSize;
    needsResize = Boolean(args.out && parseSize(args.size) && generatedSize !== args.size);
    response = await submitWithRetry(
      apiKey,
      "/images/generations",
      buildTextOnlyGenerationRequestBody(args, generatedSize),
      `VSIX text-only fallback ${generatedSize}`
    );
  }

  if (response.status !== 200) {
    const errorMessage = responseErrorMessage(response);
    fail(`VSIX API returned ${response.status}: ${errorMessage}`);
  }

  const output = pickImageOutput(response.data);
  if (!output) {
    fail("The API response did not include a usable image URL or b64_json payload.");
  }

  log("Image generation finished.");
  if (args.out) {
    try {
      let filePath = await persistOutput(output, args.out);
      if (filePath && needsResize && generatedSize !== args.size) {
        filePath = resizeImage(filePath, args.out, args.size);
      }
      if (filePath) {
        process.stdout.write(`${filePath}\n`);
        return;
      }
    } catch (error) {
      fail(`Image save failed: ${error.message}`);
    }
  }

  process.stdout.write(`${output}\n`);
}

main();
