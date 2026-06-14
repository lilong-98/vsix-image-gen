#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const https = require("https");

const HOME_DIR = process.env.HOME || process.env.USERPROFILE || "";
const CONFIG_PATH = path.join(HOME_DIR, ".vsix", "config.json");
const API_BASE = process.env.VSIX_API_BASE || "https://vsix.cc/v1";
const SUPPORTED_SIZES = [
  "1024x1024",
  "1024x1536",
  "1536x1024",
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
  if (args.out) {
    if (output.startsWith("data:image/")) {
      const filePath = saveDataUri(output, args.out);
      process.stdout.write(`${filePath}\n`);
      return;
    }

    if (isRemoteUrl(output)) {
      try {
        const filePath = await downloadFile(output, args.out);
        process.stdout.write(`${filePath}\n`);
        return;
      } catch (error) {
        fail(`Image download failed: ${error.message}`);
      }
    }
  }

  process.stdout.write(`${output}\n`);
}

main();
