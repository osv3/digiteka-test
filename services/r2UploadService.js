import fs from "node:fs/promises";
import path from "node:path";
import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";

const ROOT = process.cwd();
const GEOIP_DIR = path.join(ROOT, "tmp", "geoip-output");

const DAT_CACHE_CONTROL = "public, max-age=300, must-revalidate";
const MANIFEST_CACHE_CONTROL = "public, max-age=60, must-revalidate";

function requiredEnv(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing ${name} environment variable`);
  }

  return value;
}

function getContentType(fileName) {
  if (fileName.endsWith(".json")) return "application/json";
  if (fileName.endsWith(".dat")) return "application/octet-stream";

  return "application/octet-stream";
}

function createR2Client() {
  const accountId = requiredEnv("R2_ACCOUNT_ID");

  return new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: requiredEnv("R2_ACCESS_KEY_ID"),
      secretAccessKey: requiredEnv("R2_SECRET_ACCESS_KEY"),
    },
  });
}

function getPublicBaseUrl() {
  return requiredEnv("R2_PUBLIC_BASE_URL").replace(/\/$/, "");
}

function publicUrlForKey(key) {
  return `${getPublicBaseUrl()}/${key}`;
}

async function putFile(client, bucket, key, filePath, cacheControl) {
  const body = await fs.readFile(filePath);
  const fileName = path.basename(filePath);

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: getContentType(fileName),
      CacheControl: cacheControl,
    }),
  );

  return {
    key,
    url: publicUrlForKey(key),
    bytes: body.length,
  };
}

async function listRootDatFiles(client, bucket) {
  const keys = [];
  let continuationToken;

  do {
    const result = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        ContinuationToken: continuationToken,
      }),
    );

    for (const item of result.Contents || []) {
      const key = item.Key;

      if (!key) continue;

      const isRootFile = !key.includes("/");
      const isDatFile = key.toLowerCase().endsWith(".dat");

      if (isRootFile && isDatFile) {
        keys.push(key);
      }
    }

    continuationToken = result.NextContinuationToken;
  } while (continuationToken);

  return keys;
}

async function deleteR2Objects(client, bucket, keys) {
  if (keys.length === 0) return;

  await client.send(
    new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: {
        Objects: keys.map(key => ({ Key: key })),
      },
    }),
  );
}

export async function uploadGeoipFilesToR2() {
  const bucket = requiredEnv("R2_BUCKET");
  const client = createR2Client();

  const manifestPath = path.join(GEOIP_DIR, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));

  if (!manifest.buildId) {
    throw new Error("manifest.json does not have buildId. Run npm run update:geoip first.");
  }

  const files = await fs.readdir(GEOIP_DIR);
  const datFiles = files.filter(file => file.toLowerCase().endsWith(".dat"));

  const uploaded = {
    buildId: manifest.buildId,
    files: {},
    manifest: null,
    deletedStaleFiles: [],
  };

  for (const file of datFiles) {
    const filePath = path.join(GEOIP_DIR, file);

    uploaded.files[file] = await putFile(
      client,
      bucket,
      file,
      filePath,
      DAT_CACHE_CONTROL,
    );
  }

  const currentDatFiles = new Set(datFiles);
  const existingRootDatFiles = await listRootDatFiles(client, bucket);

  const staleDatFiles = existingRootDatFiles.filter(
    key => !currentDatFiles.has(key),
  );

  await deleteR2Objects(client, bucket, staleDatFiles);

  uploaded.deletedStaleFiles = staleDatFiles;

  const r2Combined = manifest.combined
    ? {
        ...manifest.combined,
        url: publicUrlForKey(manifest.combined.file),
      }
    : null;

  const r2Countries = {};

  for (const [country, item] of Object.entries(manifest.countries || {}).sort()) {
r2Countries[country] = {
  ...item,
  url: publicUrlForKey(item.file),
};
  }

  const r2Downloads = {};

  if (r2Combined) {
    r2Downloads.geoip = {
      type: "combined",
      file: r2Combined.file,
      bytes: r2Combined.bytes,
      sha256: r2Combined.sha256,
      url: r2Combined.url,
    };
  }

  for (const [country, item] of Object.entries(r2Countries)) {
r2Downloads[country] = {
  type: "country",
  country,
  file: item.file,
  bytes: item.bytes,
  sha256: item.sha256,
  url: item.url,
};
  }

  const r2Manifest = {
    ...manifest,
    combined: r2Combined,
    countries: r2Countries,
    storage: {
      provider: "cloudflare-r2",
      bucket,
      buildId: manifest.buildId,
      baseUrl: getPublicBaseUrl(),
    },
    client: {
      manifestUrl: publicUrlForKey("manifest.json"),
      downloadBaseUrl: getPublicBaseUrl(),
      downloads: r2Downloads,
    },
  };

  const r2ManifestPath = path.join(GEOIP_DIR, "manifest.r2.json");
  await fs.writeFile(r2ManifestPath, JSON.stringify(r2Manifest, null, 2));

  uploaded.manifest = await putFile(
    client,
    bucket,
    "manifest.json",
    r2ManifestPath,
    MANIFEST_CACHE_CONTROL,
  );

  console.log("Uploaded GeoIP files to R2.");
  console.log(JSON.stringify(uploaded, null, 2));

  return {
    manifest: r2Manifest,
    uploaded,
  };
}