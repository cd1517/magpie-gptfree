/**
 * Native OS file picker for Magpie's Providers sign-in button.
 *
 * The owner chooses a TXT in the operating system's own file dialog;
 * nothing is read until that action. No HTTP URL, external importer page,
 * shell interpolation of a selected path, or password in arguments.
 *
 * The full in-Magpie GUI is still Plugins -> GPTFree 账号导入.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { platform as osPlatform } from "node:os";

const exec = promisify(execFile);
const WINDOWS_SCRIPT = [
  "Add-Type -AssemblyName System.Windows.Forms",
  "$dlg = New-Object System.Windows.Forms.OpenFileDialog",
  '$dlg.Title = "GPTFree - 选择账号 TXT 文件"',
  '$dlg.Filter = "文本文件 (*.txt)|*.txt|所有文件 (*.*)|*.*"',
  "$dlg.CheckFileExists = $true",
  "$dlg.Multiselect = $false",
  "if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {",
  "  [Console]::OutputEncoding = [Text.Encoding]::UTF8",
  "  [Console]::WriteLine($dlg.FileName)",
  "}",
].join("; ");

export const NATIVE_PICKER_COMMANDS = Object.freeze({
  win32: {
    bin: "powershell.exe",
    args: ["-NoProfile", "-STA", "-NonInteractive", "-Command", WINDOWS_SCRIPT],
  },
  darwin: {
    bin: "osascript",
    args: [
      "-e",
      'POSIX path of (choose file with prompt "GPTFree - 选择账号 TXT 文件" of type {"public.plain-text"})',
    ],
  },
  linux: {
    bin: "zenity",
    args: [
      "--file-selection", "--title=GPTFree - 选择账号 TXT 文件",
      "--file-filter=TXT files | *.txt",
    ],
  },
});

export async function pickAccountTxt({
  platform = osPlatform(),
  runner = exec,
  signal,
} = {}) {
  const command = NATIVE_PICKER_COMMANDS[platform];
  if (!command) throw new Error("当前平台没有可用的原生 TXT 文件选择器；请使用 Magpie 左侧 Plugins → GPTFree 账号导入");
  let output;
  try {
    output = await runner(command.bin, command.args, {
      windowsHide: true, timeout: 10 * 60 * 1000,
      maxBuffer: 8 * 1024, signal, shell: false,
    });
  } catch (err) {
    // A dialog cancel or no desktop display must NOT be described as a
    // successful login; do not echo raw stderr or a file path into GUI.
    if (signal?.aborted) return "";
    if (["ENOENT", "ETIMEDOUT"].includes(err?.code))
      throw new Error("系统文件选择器不可用，请从 Magpie 左侧 Plugins → GPTFree 账号导入选择 TXT");
    return "";
  }
  const filepath = String(output?.stdout ?? "").replace(/\r?\n$/, "").trim();
  if (!filepath) return "";
  if (filepath.includes("\0") || /[\r\n]/.test(filepath) || filepath.length > 4096)
    throw new Error("选中的文件路径无效");
  if (!/\.txt$/i.test(filepath))
    throw new Error("请在系统文件选择器中选择 .txt 账号文件");
  return filepath;
}
