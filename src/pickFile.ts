/**
 * Opening the platform's file-selection window — the attach button's picker.
 *
 * A terminal cannot raise an OS dialog by itself, so the job is handed to a
 * tool the platform already ships: the .NET Forms dialog through PowerShell on
 * Windows, `zenity` on Linux, and `osascript` on macOS. That keeps the
 * zero-dependency rule — these are system programs, not npm packages — and
 * gives the user the real file browser they expected the button to open.
 *
 * Nothing here is required: when the tool is missing, the dialog is
 * cancelled, or the platform is an unknown one, the answer is null and the
 * caller falls back to typing a path in the terminal. A cancelled dialog is
 * not an error — closing the window means "never mind", and saying so would
 * only be noise.
 */

import { spawn } from "node:child_process";

/** The single path a completed dialog produced, or null for cancel/absent. */
export type PickedFile = {
  path: string;
};

/** Runs one platform command and resolves its stdout, rejecting on failure. */
export type PickCommand = (command: string, args: readonly string[]) => Promise<Buffer>;

const defaultPickCommand: PickCommand = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];

    child.on("error", reject);
    child.stdout?.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    child.on("close", (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`exit ${code}`))));
  });

/** The file-type filter the Windows dialog opens with: images and documents. */
const WIN32_FILTER =
  "Attachments (images & documents)|*.png;*.jpg;*.jpeg;*.webp;*.gif;*.md;*.txt;*.json;*.csv;*.ts;*.tsx;*.js;*.jsx;*.py;*.rs;*.go;*.java;*.c;*.h;*.cpp;*.html;*.css;*.yml;*.yaml;*.xml;*.toml;*.log;*.pdf|All files (*.*)|*.*";

const PS_OPEN_FILE_DIALOG = `
Add-Type -AssemblyName System.Windows.Forms | Out-Null
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = 'Attach a file'
$dialog.Filter = '${WIN32_FILTER}'
$dialog.CheckFileExists = $true
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.FileName }
`;

const OSASCRIPT_CHOOSE_FILE = 'POSIX path of (choose file with prompt "Attach a file")';

/** How each platform is asked for a file; null means the platform has none here. */
function sourcesFor(platform: NodeJS.Platform): Array<{ command: string; args: string[] }> {
  switch (platform) {
    case "win32":
      return [{ command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", PS_OPEN_FILE_DIALOG] }];
    case "darwin":
      return [{ command: "osascript", args: ["-e", OSASCRIPT_CHOOSE_FILE] }];
    case "linux":
    case "freebsd":
    case "openbsd":
      return [
        { command: "zenity", args: ["--file-selection", "--title=Attach a file"] },
        { command: "kdialog", args: ["--getopenfilename", ".", "*|All files"] },
      ];
    default:
      return [];
  }
}

/** Strips the quoting some dialogs add, and trims what the shell carries in. */
function cleanPath(raw: string): string {
  return raw.trim().replace(/^["']|["']$/g, "");
}

/**
 * Opens the platform's file-selection window and resolves the chosen path.
 *
 * `run` is injectable so the parsing and the cancellation can be tested
 * without a real dialog; `platform` likewise. Resolves null when no tool is
 * available or the user closed the window — the caller decides what a null
 * means (a fallback, not a failure).
 */
export async function pickFile(run: PickCommand = defaultPickCommand, platform: NodeJS.Platform = process.platform): Promise<PickedFile | null> {
  for (const source of sourcesFor(platform)) {
    try {
      const out = (await run(source.command, source.args)).toString("utf8");
      const first = cleanPath(out.split(/\r?\n/).find((line) => line.trim().length > 0) ?? "");
      if (first) return { path: first };
      // A tool that answered but named no file is the same as a cancelled dialog.
      return null;
    } catch {
      // Try the next tool; the last one falling through lands on null.
    }
  }
  return null;
}
