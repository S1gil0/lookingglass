import type { ToolRisk } from "./types.js";
import type { ShellKind } from "./shell.js";
import { posix as posixPath } from "node:path";

const SHELL_ACCESS_PATH = String.raw`(?:(?:~|\$(?:HOME|\{HOME\})|\/root|\/home\/[^\/\s]+|\.)?\/?\.ssh(?:\/\S*)?|\/?etc\/(?:ssh|sudoers(?:\.d)?|pam\.d|network|netplan|NetworkManager\/system-connections)(?:\/\S*)?|\/?etc\/(?:passwd|shadow|group|gshadow))`;

const CRITICAL_SHELL_PATTERNS: RegExp[] = [
  /(^|[;&|()\s])(?:rm|rmdir|unlink|shred|wipefs|mkfs(?:\.\w+)?|fdisk|parted|dd|truncate)(?:\s|$)/i,
  /(^|[;&|()\s])find\b[^\n;&|]*(?:-delete|-exec\s+(?:rm|rmdir|shred))\b/i,
  /(^|[;&|()\s])(?:chmod|chown|chgrp|setfacl|setcap|visudo)(?:\s|$)/i,
  /(^|[;&|()\s])(?:userdel|usermod|deluser|groupdel|groupmod|passwd|chpasswd)(?:\s|$)/i,
  /(^|[;&|()\s])(?:mount|umount|swapon|swapoff|cryptsetup|losetup|lvm|pvcreate|vgcreate|lvcreate)(?:\s|$)/i,
  /(^|[;&|()\s])(?:reboot|shutdown|poweroff|halt|init|telinit)(?:\s|$)/i,
  /(^|[;&|()\s])systemctl\b[^\n;&|]*\bisolate\b/i,
  /(^|[;&|()\s])systemctl\b[^\n;&|]*(?:stop|restart|reload|disable|mask|kill)\b[^\n;&|]*(?:ssh(?:d)?|network(?:ing)?|systemd-networkd|networkmanager|firewalld|ufw|tailscaled|wg-quick)(?:\.service)?\b/i,
  /(^|[;&|()\s])service\s+(?:ssh(?:d)?|network(?:ing)?|firewalld|ufw|tailscaled)\s+(?:stop|restart|reload)\b/i,
  /(^|[;&|()\s])loginctl\s+terminate-user\b/i,
  /(^|[;&|()\s])(?:kill|killall|pkill)\b[^\n;&|]*(?:ssh(?:d)?|networkmanager|systemd-networkd|tailscaled)\b/i,
  /(^|[;&|()\s])(?:iptables|ip6tables)\b[^\n;&|]*\s-(?:A|D|F|I|N|P|R|X|Z)\b/i,
  /(^|[;&|()\s])nft\s+(?:add|delete|destroy|flush|insert|replace|reset)\b/i,
  /(^|[;&|()\s])ufw\s+(?:allow|deny|delete|disable|enable|insert|reject|reset|route)\b/i,
  /(^|[;&|()\s])firewall-cmd\b[^\n;&|]*(?:--add-|--remove-|--set-|--reload|--complete-reload|--runtime-to-permanent)\b/i,
  /(^|[;&|()\s])ipset\s+(?:add|del|destroy|flush|restore|swap)\b/i,
  /(^|[;&|()\s])tc\s+\S+\s+(?:add|change|delete|replace)\b/i,
  /(^|[;&|()\s])(?:route\s+(?:add|del)|ifconfig\s+\S+\s+\S+)/i,
  /(^|[;&|()\s])nmcli\b[^\n;&|]*(?:\b(?:add|delete|down|modify|off|on|up)\b)/i,
  /(^|[;&|()\s])networkctl\s+(?:edit|reconfigure|reload)\b/i,
  /(^|[;&|()\s])resolvectl\s+(?:default-route|dns|domain|llmnr|mdns|revert)\b/i,
  /(^|[;&|()\s])wg\s+set\b/i,
  /(^|[;&|()\s])wg-quick\s+(?:down|up)\b/i,
  /(^|[;&|()\s])tailscale\s+(?:down|lock|logout|set|switch|up)\b/i,
  /(^|[;&|()\s])sysctl\s+(?:-w\s+)?[\w.-]+=\S+/i,
  /(^|[;&|()\s])hostnamectl\s+set-\S+\b/i,
  /(^|[;&|()\s])ip\s+(?:addr|address|link|route|rule|netns|neigh|tunnel)\s+(?:add|del|delete|replace|set|flush|change)\b/i,
  /(^|[;&|()\s])(?:ssh-keygen|visudo)(?:\s|$)/i,
  /(^|[;&|()\s])(?:terraform|tofu)\s+destroy\b/i,
  /(^|[;&|()\s])(?:aws|gcloud|az|doctl|heroku|pulumi|nomad|vault|consul)\b[^\n;&|]*\b(?:delete|destroy|remove|terminate)\b/i,
  /(^|[;&|()\s])kubectl\b[^\n;&|]*\b(?:delete|drain)\b/i,
  /(^|[;&|()\s])helm\s+uninstall\b/i,
  /(^|[;&|()\s])docker\b[^\n;&|]*\b(?:prune|rm|rmi)\b/i,
  /(^|[;&|()\s])(?:podman|nerdctl)(?:\s+compose)?\s+(?:prune|rm|rmi|down)\b/i,
  /(^|[;&|()\s])git\b[^\n;&|]*\b(?:clean|reset\s+--hard|checkout\s+--|restore|branch\s+-[dD]|tag\s+-d|remote\s+remove)(?:\s|$)/i,
  /(^|[;&|()\s])git(?:(?:\s+-C\s+\S+)|(?:\s+-c\s+\S+)|(?:\s+--(?:git-dir|work-tree)(?:=\S+|\s+\S+))|(?:\s+--\S+))*\s+push\b[^\n;&|]*(?:--delete\b|(?:^|\s)-d(?:\s|$)|--force(?:-with-lease)?\b|--mirror\b|--prune\b|(?:^|\s)-f(?:\s|$)|(?:^|\s)\+\S+|(?:^|\s):\S+)/i,
  /(^|[;&|()\s])gh\b[^\n;&|]*\bdelete\b/i,
  /(^|[;&|()\s])(?:npm|pnpm|yarn)\s+unpublish\b/i,
  /(^|[;&|()\s])(?:apt|apt-get|dnf|yum|pacman|zypper|apk|snap|flatpak)\s+(?:remove|purge|autoremove|uninstall)\b/i,
  /(^|[;&|()\s])curl\b[^\n;&|]*(?:-[Xx]\s*DELETE|--request\s+DELETE)\b/i,
  /(^|[;&|()\s])crontab\s+-r\b/i,
  /(^|[;&|()\s"'])(?:psql|mysql|mariadb|sqlite3|redis-cli|mongosh|mongo)\b[^\n;&|]*\b(?:DELETE\s+FROM|DROP\s+(?:DATABASE|SCHEMA|TABLE|INDEX|VIEW)|TRUNCATE\s+(?:DATABASE|SCHEMA|TABLE))\b/i,
  /(^|[;&|()\s"'])redis-cli\b[^\n;&|]*\b(?:DEL|UNLINK|FLUSHDB|FLUSHALL|GETDEL)\b/i,
  /(^|[;&|()\s"'])(?:mongosh|mongo)\b[^\n;&|]*\b(?:deleteOne|deleteMany|dropDatabase|drop|remove)\s*\(/i,
  new RegExp(String.raw`(?:>{1,2}\|?|<>|&>)\s*["']?${SHELL_ACCESS_PATH}`, "i"),
  new RegExp(String.raw`(^|[;&|()\s])sed\s+-i\b[^\n;&|]*[\s"']${SHELL_ACCESS_PATH}`, "i"),
  new RegExp(String.raw`(^|[;&|()\s])tee\b(?:\s+-\S+)*\s+["']?${SHELL_ACCESS_PATH}["']?(?:\s|$|[;&|])`, "i"),
  new RegExp(String.raw`(^|[;&|()\s])(?:cp|mv|install)\b[^\n;&|]*[\s"']${SHELL_ACCESS_PATH}["']?\s*(?:$|[;&|])`, "i"),
  new RegExp(String.raw`(^|[;&|()\s])(?:cp|mv|install)\b[^\n;&|]*(?:--target-directory(?:=|\s+)|-t\s+)["']?${SHELL_ACCESS_PATH}`, "i"),
];

// Native PowerShell cmdlets and common Windows command aliases. Keep these
// separate from the Bash patterns so Windows coverage cannot weaken POSIX
// classification.
const CRITICAL_POWERSHELL_PATTERNS: RegExp[] = [
  // Wrappers and dynamic launchers can execute a different command from the
  // visible leading token. Keep this lexical classification conservative; it
  // is not intended to replace PowerShell parsing.
  /(^|[\s;&|()])cmd(?:\.exe)?\s+\/c(?:\s|$)/i,
  /(^|[\s;&|()])(?:powershell|pwsh)(?:\.exe)?\b/i,
  /(^|[\s;&|()])(?:-|\/)EncodedCommand(?:\s|$)/i,
  /\b(?:Process\s*\.\s*Start|(?:System\.)?Diagnostics\.Process\s*\]?\s*::\s*Start)\b/i,
  /(^|[\s;&|()])(?:Invoke-Expression|Invoke-Command|iex)\b/i,
  /(^|[\s;&|()])Start-Process\b/i,
  /(^|[\s;&|()])&\s*(?:[$({]|(?:"[^"]*(?:[$`]\(|[$`])|\S*[$`]))/i,
  /(^|[\s;&|()])(?:Remove-Item|del|erase|rmdir|rd|rm|ri)(?:\.exe)?\b/i,
  /(^|[\s;&|()])(?:Stop|Restart)-Service\b/i,
  /(^|[\s;&|()])(?:Remove|Set|New)-Service\b/i,
  /(^|[\s;&|()])sc(?:\.exe)?\s+(?:delete|stop|config|failure|failureflag)\b/i,
  /(^|[\s;&|()])(?:Stop-Process|taskkill|kill)(?:\.exe)?\b/i,
  /(^|[\s;&|()])shutdown(?:\.exe)?\b/i,
  /(^|[\s;&|()])(?:format|diskpart)(?:\.exe|\.com)?\b/i,
  /(^|[\s;&|()])(?:Set-Acl|takeown|icacls)(?:\.exe)?\b/i,
  /(^|[\s;&|()])(?:Clear-RecycleBin|(?:New|Remove|Set)-(?:SmbShare|ScheduledTask))\b/i,
  /(^|[\s;&|()])(?:New|Remove|Set|Disable|Enable|Restart)-Net(?:Firewall(?:Rule|Profile)?|Adapter|IPAddress|IPInterface|Route|Nat)\b/i,
  /(^|[\s;&|()])Set-DnsClientServerAddress\b/i,
  /(^|[\s;&|()])reg(?:\.exe)?\s+delete\b/i,
  /(^|[\s;&|()])(?:New|Remove|Set)-Item(?:Property)?\b[^\n;&|]*(?:Registry::|(?:HKLM|HKCU|HKCR|HKU|HKCC):|HKEY_(?:LOCAL_MACHINE|CURRENT_USER|CLASSES_ROOT|USERS|CURRENT_CONFIG))/i,
  /(^|[\s;&|()])bcdedit(?:\.exe)?\s+\/(?:delete(?:value)?|set|remove|timeout|bootsequence|default)\b/i,
  /(^|[\s;&|()])(?:New|Remove|Set|Rename|Disable|Enable)-(?:LocalUser|LocalGroup)(?:Member)?\b/i,
  /(^|[\s;&|()])(?:Add|Remove)-(?:LocalGroupMember)\b/i,
  /(^|[\s;&|()])net(?:\.exe)?\s+(?:user|localgroup)\b/i,
  /(^|[\s;&|()])netsh(?:\.exe)?\b[^\n;&|]*(?:firewall|advfirewall|interface|ipsec|winsock|portproxy)\b/i,
  /(^|[\s;&|()])(?:route|netsh)(?:\.exe)?\b[^\n;&|]*(?:\b(?:add|change|delete|del|remove|set|reset|flush)\b)/i,
];

const POWERSHELL_SENSITIVE_DESTINATION = /(?:\$\{?env:(?:SystemRoot|WinDir|ProgramData|ProgramFiles(?:X86)?)\b\}?|(?:^|[\\/])(?:Windows|ProgramData|Program Files(?: \(x86\))?)(?:[\\/]|$)|(?:^|[\\/])(?:\.ssh|authorized_keys|hosts|SAM|SECURITY|SYSTEM)(?:[\\/]|$))/i;
const POWERSHELL_MUTATING_FILE_CMDLET = /(^|[\s;&|()])(?:Set-Content|Add-Content|Out-File|Clear-Content|(?:Move|Copy|Rename)-Item)\b/i;
const POWERSHELL_DESTRUCTIVE_FILE_OPERATION = /(^|[\s;&|()])(?:Clear-Content\b|(?:(?:Set|Add)-Content|Out-File|(?:Move|Copy|Rename)-Item)\b[^\n;&|]*(?:-Force\b|-Recurse\b|-Confirm\s*:\s*\$(?:false|0)\b))/i;
const POWERSHELL_SENSITIVE_REDIRECTION = /(?:^|[\s;&|()])(?:\d+|\*)?>{1,2}\s*(?:"([^"]*)"|'([^']*)'|([^\s;&|()]+))/g;
const POWERSHELL_DOTNET_FILE_WRITE = /\[(?:System\.)?IO\.File\]::(?:WriteAll(?:Text|Lines|Bytes)|AppendAll(?:Text|Lines)|Create(?:Text)?|Open(?:Write)?)(?:Async)?\s*\(\s*(?:"([^"]*)"|'([^']*)'|([^,\s)]+))/gi;
const POWERSHELL_DOTNET_FILE_DELETE = /\b(?:System\.)?IO\.File\]?\s*::\s*Delete\b|\b(?:System\.)?IO\.File\s*\.\s*Delete\b|\bFile\s*\.\s*Delete\b/i;

const ACCESS_LOCKOUT_PATCH_PATH = /(?:^|\/)(?:\.ssh|authorized_keys|etc\/(?:ssh|sudoers(?:\.d)?|pam\.d|network|netplan|NetworkManager\/system-connections))(?:\/|$)/i;

const NON_EXECUTABLE_SHELL_WORDS = new Set([
  ".", "!",
  "case", "coproc", "do", "done", "elif", "else", "esac", "fi", "for", "function", "if", "in", "select", "then", "until", "while",
]);

function normalizedShellText(command: string): string {
  return command
    .replace(/\\([A-Za-z])/g, "$1")
    .replace(/(["'])([A-Za-z][\w.-]*)\1/g, "$2")
    .replace(/(?<=[A-Za-z])["']{2}(?=[A-Za-z])/g, "")
    .replace(/(^|[;&|()\s])\/(?:usr\/)?s?bin\/(?=[\w.-])/g, "$1");
}

function normalizedPowerShellText(command: string): string {
  // A quoted command name is still executable when invoked through `&`. Turn
  // only literal names into the form covered by the native command patterns;
  // interpolated names remain dynamic and retain their critical classification.
  return command.replace(/(^|[\s;&|()])&\s*(["'])([^"'`$]+)\2/g, (_match, boundary: string, _quote: string, executable: string) => {
    const basename = executable.replace(/^.*[\\/]/, "");
    return `${boundary}${basename}`;
  });
}

function hasSensitivePowerShellRedirection(command: string): boolean {
  for (const match of command.matchAll(POWERSHELL_SENSITIVE_REDIRECTION)) {
    const destination = match[1] ?? match[2] ?? match[3] ?? "";
    if (POWERSHELL_SENSITIVE_DESTINATION.test(destination)) return true;
  }
  return false;
}

function hasSensitiveDotNetFileWrite(command: string): boolean {
  for (const match of command.matchAll(POWERSHELL_DOTNET_FILE_WRITE)) {
    const destination = match[1] ?? match[2] ?? match[3] ?? "";
    if (POWERSHELL_SENSITIVE_DESTINATION.test(destination)) return true;
  }
  return false;
}

export function bashCommandRisk(command: string): ToolRisk {
  const normalized = normalizedShellText(command);
  return CRITICAL_SHELL_PATTERNS.some((pattern) => pattern.test(normalized)) ? "critical" : "shell";
}

export function bashExecutionRisk(command: string): ToolRisk {
  return bashCommandRisk(command);
}

export function powershellCommandRisk(command: string): ToolRisk {
  const normalized = normalizedPowerShellText(command);
  if (CRITICAL_POWERSHELL_PATTERNS.some((pattern) => pattern.test(normalized))) return "critical";
  if (hasSensitivePowerShellRedirection(normalized)
    || hasSensitiveDotNetFileWrite(normalized)
    || POWERSHELL_DOTNET_FILE_DELETE.test(normalized)) return "critical";
  if (POWERSHELL_MUTATING_FILE_CMDLET.test(normalized)
    && (POWERSHELL_SENSITIVE_DESTINATION.test(normalized) || POWERSHELL_DESTRUCTIVE_FILE_OPERATION.test(normalized))) {
    return "critical";
  }
  return "shell";
}

export function powershellExecutionRisk(command: string): ToolRisk {
  return powershellCommandRisk(command);
}

export function shellCommandRisk(command: string, kind: ShellKind): ToolRisk {
  return kind === "powershell" ? powershellCommandRisk(command) : bashCommandRisk(command);
}

export function bashApprovalExecutable(command: string): string | null {
  if (!command.trim()) return null;
  const words: string[] = [];
  let word = "";
  let started = false;
  let quote: "single" | "double" | null = null;
  let escaped = false;
  const finishWord = (): void => {
    if (!started) return;
    words.push(word);
    word = "";
    started = false;
  };
  const hasExecutable = (): boolean => {
    const candidate = words.at(-1);
    return Boolean(candidate && !/^[A-Za-z_][A-Za-z0-9_]*(?:\+)?=/.test(candidate));
  };
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (escaped) {
      word += character;
      started = true;
      escaped = false;
      continue;
    }
    if (quote === "single") {
      if (character === "'") quote = null;
      else word += character;
      started = true;
      continue;
    }
    if (quote === "double") {
      if (character === '"') quote = null;
      else if (character === "\\") escaped = true;
      else {
        if (character === "`" || (character === "$" && command[index + 1] === "(")) return null;
        word += character;
      }
      started = true;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      started = true;
      continue;
    }
    if (character === "'") {
      quote = "single";
      started = true;
      continue;
    }
    if (character === '"') {
      quote = "double";
      started = true;
      continue;
    }
    if (/\s/.test(character)) {
      finishWord();
      if (hasExecutable()) break;
      continue;
    }
    if (character === "#" && !started) break;
    if (";&|(){}<>`".includes(character)) {
      if (!started) return null;
      finishWord();
      break;
    }
    if (character === "$" && command[index + 1] === "(") return null;
    word += character;
    started = true;
  }
  if (quote || escaped) return null;
  finishWord();
  const executable = words.find((candidate) => !/^[A-Za-z_][A-Za-z0-9_]*(?:\+)?=/.test(candidate));
  if (!executable || /[$*?\[]/.test(executable) || NON_EXECUTABLE_SHELL_WORDS.has(executable)) return null;
  const systemExecutable = /^\/(?:usr\/)?(?:s?bin)\/([^/]+)$/.exec(executable)?.[1];
  return systemExecutable ?? executable;
}

export function isSensitiveMutationPath(path: string): boolean {
  const normalized = posixPath.resolve("/", path.replaceAll("\\", "/")).slice(1);
  if (ACCESS_LOCKOUT_PATCH_PATH.test(normalized)) return true;
  return /(?:^|\/)etc\/(?:passwd|shadow|group|gshadow)$/.test(normalized);
}

export function patchRisk(patch: string): ToolRisk {
  for (const line of patch.split("\n")) {
    if (line.startsWith("*** Delete File:")) return "critical";
    const path = /^(?:\*\*\* (?:Add|Update) File:|\*\*\* Move to:)\s*(.+)$/.exec(line)?.[1]?.trim();
    if (path) {
      if (isSensitiveMutationPath(path)) return "critical";
    }
  }
  return "write";
}

export function workspacePatchRisk(workspace: string, patch: string): ToolRisk {
  void workspace;
  return patchRisk(patch);
}

export function shellEnvironment(
  base: NodeJS.ProcessEnv = process.env,
  excludedKeys: Iterable<string> = [],
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const env = { ...base };
  const windows = platform === "win32";
  for (const key of Object.keys(env)) {
    if (windows ? key.toLowerCase().startsWith("bash_func_") : key.startsWith("BASH_FUNC_")) delete env[key];
  }
  for (const key of ["BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS", "CDPATH", "GLOBIGNORE", "PROMPT_COMMAND", "RIPGREP_CONFIG_PATH"]) {
    if (windows) {
      for (const candidate of Object.keys(env)) {
        if (candidate.toLowerCase() === key.toLowerCase()) delete env[candidate];
      }
    } else {
      delete env[key];
    }
  }
  if (windows) {
    // -NoProfile prevents profile scripts, while these environment values can
    // still affect module loading, execution policy, or profile discovery.
    for (const key of [
      "PSModulePath",
      "PSExecutionPolicyPreference",
      "__PSLockDownPolicy",
      "PROFILE",
      "PSProfile",
      "PowerShellProfile",
      "POWERSHELL_PROFILE",
      "POWERSHELL_PROFILE_PATH",
    ]) {
      for (const candidate of Object.keys(env)) {
        if (candidate.toLowerCase() === key.toLowerCase()) delete env[candidate];
      }
    }
  }
  const excluded = windows
    ? new Set([...excludedKeys].map((key) => key.toLowerCase()))
    : new Set(excludedKeys);
  for (const key of Object.keys(env)) {
    if (excluded.has(windows ? key.toLowerCase() : key)) delete env[key];
  }
  return env;
}
