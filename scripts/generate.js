#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const https = require("https");

const HOME_DIR = process.env.HOME || process.env.USERPROFILE || "";
const CONFIG_PATH = path.join(HOME_DIR, ".vsix", "config.json");
const API_BASE = process.env.VSIX_API_BASE || "https://vsix.cc/v1";
const SUPPORTED_SIZES = new Set([
  "1024x1024",
  "1024x1536",
  "1536x1024",
  "auto",
]);
const SIZE_ALIASES = {
  "1:1": "1024x1024",
  "3:4": "1024x1536",
  "4:3": "1536x1024",
  square: "1024x1024",
  portrait: "1024x1536",
  landscape: "1536x1024",
};
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

function printHelp() {
  log("Usage:");
  log('  node generate.js --prompt "Describe the image" [--size 1024x1024] [--image-url URL_OR_FILE]');
  log("");
  log("Supported sizes:");
  log("  1024x1024, 1024x1536, 1536x1024, auto");
  log("Aliases:");
  log("  1:1, 3:4, 4:3, square, portrait, landscape");
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

  if (!SUPPORTED_SIZES.has(normalized)) {
    fail(
      `Unsupported size "${rawSize}". Use one of: ${Array.from(SUPPORTED_SIZES).join(", ")} or aliases ${Object.keys(
        SIZE_ALIASES
      ).join(", ")}.`
    );
  }

  return normalized;
}

function parseArgs(argv) {
  const parsed = {
    prompt: "",
    size: "1024x1024",
    imageUrls: [],
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
    return value;
  }

  const filePath = resolveLocalFile(value);
  if (!fs.existsSync(filePath)) {
    fail(`Reference image not found: ${value}`);
  }

  const mimeType = getMimeType(filePath);
  const fileBuffer = fs.readFileSync(filePath);
  return `data:${mimeType};base64,${fileBuffer.toString("base64")}`;
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = loadApiKey();
  const normalizedImages = args.imageUrls.map(normalizeImageInput);

  log(`Prompt: ${args.prompt}`);
  log(`Size: ${args.size}`);
  if (normalizedImages.length > 0) {
    log(`Reference images: ${normalizedImages.length}`);
  }
  log("Requesting image generation from VSIX...");

  const requestBody = {
    model: "gpt-image-2",
    prompt: args.prompt,
    n: 1,
    size: args.size,
  };

  if (normalizedImages.length === 1) {
    requestBody.image = normalizedImages[0];
  } else if (normalizedImages.length > 1) {
    requestBody.image = normalizedImages;
  }

  let response;
  try {
    response = await requestJson(`${API_BASE}/images/generations`, apiKey, requestBody);
  } catch (error) {
    fail(`Request failed: ${error.message}`);
  }

  if (response.status !== 200) {
    const errorMessage =
      response.data &&
      response.data.error &&
      response.data.error.message
        ? response.data.error.message
        : typeof response.data === "string"
          ? response.data
          : JSON.stringify(response.data);
    fail(`VSIX API returned ${response.status}: ${errorMessage}`);
  }

  const output = pickImageOutput(response.data);
  if (!output) {
    fail("The API response did not include a usable image URL or b64_json payload.");
  }

  log("Image generation finished.");
  process.stdout.write(`${output}\n`);
}

main();
