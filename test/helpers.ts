import { platform } from "node:os";

export const isWindows = platform() === "win32";

function posixLiteral(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function powershellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function shellCommand(posix: string, powershell: string): string {
  return isWindows ? powershell : posix;
}

export function outputCommand(value: string, stream: "stdout" | "stderr" = "stdout"): string {
  return shellCommand(
    `printf '%s' ${posixLiteral(value)}${stream === "stderr" ? " >&2" : ""}`,
    `[Console]::${stream === "stderr" ? "Error" : "Out"}.Write(${powershellLiteral(value)})`,
  );
}

export function outputEnvironmentCommand(name: string): string {
  return shellCommand(
    `printf '%s' "$${name}"`,
    `[Console]::Out.Write($env:${name})`,
  );
}

export function sleepCommand(seconds: number): string {
  return shellCommand(`sleep ${seconds}`, `Start-Sleep -Seconds ${seconds}`);
}

export function successCommand(): string {
  return "exit 0";
}

export function failureCommand(code: number, stderr: string): string {
  return `${outputCommand(stderr, "stderr")}; exit ${code}`;
}

export function largeOutputCommand(character: string, count: number): string {
  return shellCommand(
    `node -e "process.stdout.write('${character}'.repeat(${count}))"`,
    `[Console]::Out.Write(((${powershellLiteral(character)} * ${count}) -join ''))`,
  );
}

export function removeDirectoryCommand(path: string): string {
  return shellCommand(
    `rm -rf ${posixLiteral(path)}`,
    `if (Test-Path -LiteralPath ${powershellLiteral(path)}) { Remove-Item -LiteralPath ${powershellLiteral(path)} -Recurse -Force }`,
  );
}

export function writeFileCommand(path: string, value: string): string {
  return shellCommand(
    `printf '%s' ${posixLiteral(value)} > ${posixLiteral(path)}`,
    `[IO.File]::WriteAllText(${powershellLiteral(path)}, ${powershellLiteral(value)})`,
  );
}

export function transformInputCommand(): string {
  return shellCommand(
    "cat input.txt > output.txt && sed -i 's/before/after/' output.txt",
    "[IO.File]::WriteAllText('output.txt', ([IO.File]::ReadAllText('input.txt')).Replace('before', 'after'))",
  );
}

export function writeMarkerCommand(path: string): string {
  return shellCommand(
    `touch ${posixLiteral(path)}`,
    `[IO.File]::WriteAllText(${powershellLiteral(path)}, '')`,
  );
}

export function checkEnvironmentUnsetCommand(name: string, value: string): string {
  return shellCommand(
    `if [ -z "$${name}" ]; then printf '%s' ${posixLiteral(value)}; else printf '%s' "$${name}"; fi`,
    `if ([string]::IsNullOrEmpty($env:${name})) { [Console]::Out.Write(${powershellLiteral(value)}) } else { [Console]::Out.Write($env:${name}) }`,
  );
}

export function truncatedOutputCommand(stdout: string, stderr: string): string {
  return `${outputCommand(stdout)}; ${outputCommand(stderr, "stderr")}`;
}

export function compoundWriteCommand(path: string, value: string): string {
  return `${writeFileCommand(path, value)}; exit 0`;
}