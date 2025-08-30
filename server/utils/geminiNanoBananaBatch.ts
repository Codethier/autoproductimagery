import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { lookup as lookupMime } from "mime-types";


const runtimeConfig = useRuntimeConfig()

type StartOptions = {
  prompt?: string;
  model?: string;
  inputDir?: string;
  displayName?: string;
  pollAndDownload?: boolean;
  outputDir?: string;
  maxWaitMs?: number;
  pollIntervalMs?: number;
};

type BatchHandle = {
  name: string;
  state: string;
  outputFile?: string;
  errorFile?: string;
};

const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta";

function nowStamp() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    d.getFullYear() +
    String(d.getMonth() + 1).padStart(2, "0") +
    String(d.getDate()).padStart(2, "0") +
    "-" +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function listInputImages(dir: string) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile())
    .map((e) => path.join(dir, e.name))
    .filter((p) => {
      const ext = path.extname(p).toLowerCase();
      return [".png", ".jpg", ".jpeg", ".webp"].includes(ext);
    });
  return files;
}

/**
Uploads a local file to Gemini Files API using multipart/related.
Returns the Files resource: { name: "files/...", uri: "..." }.
Docs: Files API (multipart/related) and Batch Mode input-file.
*/
async function uploadFileMultipart(
  filePath: string,
  mimeType: string,
  displayName?: string
) {
  const fileBuf = await fs.readFile(filePath);
  const boundary =
    "----ai-google-boundary-" + Math.random().toString(16).slice(2);

  const metadata = {
    file: {
      displayName: displayName || path.basename(filePath),
      mimeType,
    },
  };

  const head =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n`;

  const tail = `\r\n--${boundary}--\r\n`;

  const body = Buffer.concat([
    Buffer.from(head, "utf8"),
    fileBuf,
    Buffer.from(tail, "utf8"),
  ]);

  const resp = await fetch(`${GEMINI_API}/files:upload`, {
    method: "POST",
    headers: {
      "Content-Type": `multipart/related; boundary=${boundary}`,
      "x-goog-api-key": process.env.GEMINI_API_KEY as string,
    },
    body,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `Files upload failed: ${resp.status} ${resp.statusText}\n${text}`
    );
  }

  const data = (await resp.json()) as { file: any };
  return data.file; // { name, uri, ... }
}

/**
Build JSONL content for the Batch Mode input file.
Each line is: { customId, request: { model, tools, contents, generationConfig } }
For native image generation (Nano Banana), enable tools.imageGeneration.
*/
function buildNanoBananaJsonl(
  items: Array<{
    customId: string;
    fileUri: string;
    mimeType: string;
    prompt: string;
    model: string;
  }>
) {
  const lines = items.map((it) =>
    JSON.stringify({
      customId: it.customId,
      request: {
        model: it.model, // e.g. "models/gemini-2.5-flash"
        tools: [{ imageGeneration: {} }],
        contents: [
          {
            role: "user",
            parts: [
              { text: it.prompt },
              {
                fileData: {
                  fileUri: it.fileUri,
                  mimeType: it.mimeType,
                },
              },
            ],
          },
        ],
        generationConfig: {
          responseMimeType: "image/png",
        },
      },
    })
  );
  return lines.join("\n") + "\n";
}

/**
Create a batch job from the uploaded JSONL input file.
*/
async function createBatch(inputFileName: string, displayName: string) {
  const resp = await fetch(`${GEMINI_API}/batches`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": process.env.GEMINI_API_KEY as string,
    },
    body: JSON.stringify({
      displayName,
      input: { file: inputFileName, mimeType: "application/jsonl" },
      outputConfig: {},
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `Failed to create batch: ${resp.status} ${resp.statusText}\n${text}`
    );
  }

  const data = (await resp.json()) as {
    name: string;
    state: string;
    output?: { file?: string };
    errorOutput?: { file?: string };
  };

  const batch: BatchHandle = {
    name: data.name,
    state: data.state,
    outputFile: data.output?.file,
    errorFile: data.errorOutput?.file,
  };
  return batch;
}

async function getBatch(name: string): Promise<BatchHandle> {
  const resp = await fetch(`${GEMINI_API}/${name}`, {
    headers: { "x-goog-api-key": process.env.GEMINI_API_KEY as string },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `Failed to get batch: ${resp.status} ${resp.statusText}\n${text}`
    );
  }
  const data = (await resp.json()) as {
    name: string;
    state: string;
    output?: { file?: string };
    errorOutput?: { file?: string };
  };
  return {
    name: data.name,
    state: data.state,
    outputFile: data.output?.file,
    errorFile: data.errorOutput?.file,
  };
}

async function downloadFileContent(fileName: string): Promise<string> {
  const resp = await fetch(`${GEMINI_API}/${fileName}:content`, {
    headers: { "x-goog-api-key": process.env.GEMINI_API_KEY as string },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `Failed to download file ${fileName}: ${resp.status} ${resp.statusText}\n${text}`
    );
  }
  return await resp.text();
}

/**
Parse JSONL batch output and write any inlineData images to disk.
*/
async function writeImagesFromBatchJsonl(jsonl: string, outDir: string) {
  await fs.mkdir(outDir, { recursive: true });
  const lines = jsonl
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  let saved = 0;

  for (const line of lines) {
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const customId = obj.customId || "item";
    const candidates = obj.response?.candidates ?? [];
    for (const c of candidates) {
      const parts = c?.content?.parts ?? [];
      let imgIndex = 0;
      for (const p of parts) {
        const inline = p?.inlineData;
        if (inline?.data && inline?.mimeType?.startsWith("image/")) {
          const ext =
            inline.mimeType === "image/png"
              ? "png"
              : inline.mimeType === "image/jpeg"
              ? "jpg"
              : "bin";
          const outPath = path.join(
            outDir,
            `${customId}-${String(imgIndex).padStart(2, "0")}.${ext}`
          );
          const buf = Buffer.from(inline.data, "base64");
          await fs.writeFile(outPath, buf);
          imgIndex += 1;
          saved += 1;
        }
      }
    }
  }

  return saved;
}

/**
Main entry: batch Nano Banana from images in ./input.
*/
export async function runNanoBananaBatchFromInputFolder(
  opts: StartOptions = {}
) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not set");
  }

  const {
    prompt = "Create a high-quality stylized variation of this image. Return a single PNG.",
    // Use full model path per REST docs
    model = "models/gemini-2.5-flash",
    inputDir = path.join(process.cwd(), "input"),
    displayName = `nano-banana-batch-${nowStamp()}`,
    pollAndDownload = false,
    outputDir = path.join(process.cwd(), "output"),
    maxWaitMs = 30 * 60 * 1000,
    pollIntervalMs = 5000,
  } = opts;

  const images = await listInputImages(inputDir);
  if (images.length === 0) {
    throw new Error(`No images found in ${inputDir}`);
  }

  // 1) Upload input images
  const uploaded = [];
  for (const imgPath of images) {
    const mimeType = (lookupMime(imgPath) ||
      "application/octet-stream") as string;
    const file = await uploadFileMultipart(
      imgPath,
      mimeType,
      path.basename(imgPath)
    );
    uploaded.push({ localPath: imgPath, file, mimeType });
  }

  // 2) Build JSONL input
  const jsonlItems = uploaded.map((u) => ({
    customId: path.parse(u.localPath).name,
    fileUri: u.file.uri,
    mimeType: u.mimeType,
    prompt,
    model,
  }));
  const jsonlContent = buildNanoBananaJsonl(jsonlItems);

  const tmpJsonlPath = path.join(
    os.tmpdir(),
    `nano-banana-input-${nowStamp()}.jsonl`
  );
  await fs.writeFile(tmpJsonlPath, jsonlContent, "utf8");

  // Upload JSONL input file
  const inputFile = await uploadFileMultipart(
    tmpJsonlPath,
    "application/jsonl",
    path.basename(tmpJsonlPath)
  );

  // 3) Create batch
  const batch = await createBatch(inputFile.name, displayName);

  if (!pollAndDownload) {
    return {
      message:
        "Batch created. Set pollAndDownload=true to auto-download results.",
      batch,
    };
  }

  // 4) Poll and download results
  const start = Date.now();
  let current = await getBatch(batch.name);
  while (
    current.state === "JOB_STATE_PENDING" ||
    current.state === "JOB_STATE_RUNNING" ||
    current.state === "STATE_UNSPECIFIED"
  ) {
    if (Date.now() - start > maxWaitMs) {
      throw new Error(
        `Timed out waiting for batch ${current.name} (state=${current.state})`
      );
    }
    await sleep(pollIntervalMs);
    current = await getBatch(batch.name);
  }

  if (current.state !== "JOB_STATE_SUCCEEDED") {
    const errorFile = current.errorFile
      ? ` (error file: ${current.errorFile})`
      : "";
    throw new Error(`Batch failed or cancelled: ${current.state}${errorFile}`);
  }

  if (!current.outputFile) {
    return {
      message:
        "Batch succeeded but no outputFile reported. Check job in UI/API.",
      batch: current,
    };
  }

  const outJsonl = await downloadFileContent(current.outputFile);
  const savedCount = await writeImagesFromBatchJsonl(outJsonl, outputDir);

  return {
    message: `Batch succeeded. Saved ${savedCount} image(s) to ${outputDir}`,
    batch: current,
    outputDir,
    savedCount,
  };
}