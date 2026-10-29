// PC에 설치된 Claude Code를 구독 계정으로 실행해 요약·번역 확인 결과를 받는다. API 키는 쓰지 않는다.
// --safe-mode: CLAUDE.md·훅·플러그인 같은 개인 설정을 읽지 않는다 / --tools "": 도구 없이 글만 쓴다
// Node 모듈(child_process 등)은 PC 앱에서만 있으므로 require를 주입받는다.

const SYSTEM = "You work on web articles as instructed. Output only what is requested, with no preamble, notes or code fences.";

/** 설치 위치 찾기: 직접 넣은 경로 → 기본 설치 위치 → PATH의 claude */
export function findClaude(req, custom = "") {
  if (custom.trim()) return custom.trim();
  const fs = req("fs");
  const os = req("os");
  const path = req("path");
  const home = os.homedir();
  const candidates =
    process.platform === "win32"
      ? [path.join(home, ".local", "bin", "claude.exe"), path.join(process.env.APPDATA || home, "npm", "claude.cmd")]
      : [path.join(home, ".local", "bin", "claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"];
  return candidates.find((p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  }) || "claude";
}

/**
 * @param {(name:string)=>any} req  Node의 require
 * @returns {(prompt:string, opts?:{system?:string})=>Promise<string>}  system: 시스템 지시에 덧붙일 말 (출력 언어 등)
 */
export function claudeRunner(req, { cliPath = "", model = "sonnet", timeoutMs = 5 * 60 * 1000 } = {}) {
  const { spawn } = req("child_process");
  const os = req("os");
  const cmd = findClaude(req, cliPath);
  // npm으로 설치한 claude.cmd는 셸을 거쳐야 실행된다. 이때는 인자를 직접 따옴표로 감싼다
  const shell = /\.(cmd|bat)$/i.test(cmd);
  const quote = (a) => (shell ? `"${a.replace(/"/g, '""')}"` : a);

  return (prompt, { system = "" } = {}) =>
    new Promise((resolve, reject) => {
      const sys = system ? `${SYSTEM} ${system}` : SYSTEM;
      const args = ["-p", "--safe-mode", "--tools", "", "--no-session-persistence", "--model", model, "--effort", "low", "--output-format", "json", "--system-prompt", sys];
      const child = spawn(quote(cmd), args.map(quote), { cwd: os.tmpdir(), windowsHide: true, shell });
      let out = "";
      let err = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("응답 시간 초과"));
      }, timeoutMs);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e.code === "ENOENT" ? new Error("Claude Code를 찾지 못했습니다") : e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        let j = null;
        try {
          j = JSON.parse(out);
        } catch {}
        if (j && !j.is_error && typeof j.result === "string" && j.result.trim()) return resolve(j.result);
        reject(new Error((j && j.result) || err.trim().split("\n").pop() || `종료 코드 ${code}`));
      });
      child.stdin.on("error", () => {});
      child.stdin.end(prompt, "utf8");
    });
}
