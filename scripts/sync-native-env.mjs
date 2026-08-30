import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nativePath = path.join(projectRoot, ".env");
const nativeTemplatePath = path.join(projectRoot, ".env.example");
const dockerPath = path.join(projectRoot, ".env.docker");

function parseEnvironment(content) {
  return Object.fromEntries(
    content
      .split(/\r?\n/u)
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

function setValue(content, key, value) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, "mu");
  return pattern.test(content)
    ? content.replace(pattern, line)
    : `${content.trimEnd()}\n${line}\n`;
}

if (!fs.existsSync(dockerPath)) {
  throw new Error("缺少 .env.docker，无法复用现有 MySQL 凭据");
}

const dockerEnvironment = parseEnvironment(fs.readFileSync(dockerPath, "utf8"));
const requiredDockerKeys = [
  "MYSQL_DATABASE",
  "MYSQL_USER",
  "MYSQL_PASSWORD",
  "ADMIN_PASSWORD",
];
for (const key of requiredDockerKeys) {
  if (!dockerEnvironment[key]) throw new Error(`.env.docker 缺少 ${key}`);
}

let nativeContent = fs.existsSync(nativePath)
  ? fs.readFileSync(nativePath, "utf8")
  : fs.readFileSync(nativeTemplatePath, "utf8");
const updates = {
  APP_HOST: "127.0.0.1",
  APP_DATA_DIR: "./data",
  PDF_OCR_TEMP_DIR: "./data/ocr-temp",
  DB_HOST: "127.0.0.1",
  DB_PORT: "3306",
  DB_USER: dockerEnvironment.MYSQL_USER,
  DB_PASSWORD: dockerEnvironment.MYSQL_PASSWORD,
  DB_NAME: dockerEnvironment.MYSQL_DATABASE,
  ADMIN_PASSWORD: dockerEnvironment.ADMIN_PASSWORD,
};
for (const [key, value] of Object.entries(updates)) {
  nativeContent = setValue(nativeContent, key, value);
}

const temporaryPath = `${nativePath}.tmp`;
fs.writeFileSync(temporaryPath, nativeContent, { encoding: "utf8", mode: 0o600 });
fs.renameSync(temporaryPath, nativePath);
fs.chmodSync(nativePath, 0o600);
console.log("已同步宿主机 .env；未显示或修改现有 Docker 密钥。");
