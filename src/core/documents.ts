import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

/** Explicit paths never replace files; generated downloads get a private directory. */
export async function saveDocument(
  bytes: Uint8Array,
  suggestedFilename: string,
  outputPath?: string,
  downloadDirectory?: string,
): Promise<string> {
  if (
    downloadDirectory &&
    outputPath &&
    (basename(outputPath) !== outputPath ||
      outputPath.includes("\\") ||
      outputPath === "." ||
      outputPath === "..")
  )
    throw new Error(
      "Hosted downloads accept a filename only, within the server download directory.",
    );
  const filename = basename(suggestedFilename.replace(/\\/g, "/")).replace(
    /[^\p{L}\p{N}._-]/gu,
    "_",
  );
  const safeName =
    filename && filename !== "." && filename !== ".."
      ? filename
      : "document.pdf";
  let target: string;
  if (outputPath) {
    if (downloadDirectory)
      await mkdir(downloadDirectory, { recursive: true, mode: 0o700 });
    target = downloadDirectory
      ? join(downloadDirectory, outputPath)
      : resolve(outputPath);
  } else {
    const root = downloadDirectory ?? tmpdir();
    await mkdir(root, { recursive: true, mode: 0o700 });
    target = join(await mkdtemp(join(root, "disclosures-")), safeName);
  }
  await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
  return target;
}
