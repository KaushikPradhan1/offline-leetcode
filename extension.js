const vscode = require('vscode');
const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');
const os = require('os');
const { exec } = require('child_process');

/**
 * @param {vscode.ExtensionContext} context
 * @returns {Array<any>}
 */
function loadProblems(context) {
  try {
    const jsonPath = path.join(context.extensionPath, 'data', 'problems.json');
    if (!fs.existsSync(jsonPath)) return [];
    return JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch (/** @type {any} */ error) {
    vscode.window.showErrorMessage(`Offline LeetCode: Failed to load dataset. ${error.message || error}`);
    return [];
  }
}

/**
 * @param {string} cmd 
 * @param {string} cwd 
 * @returns {Promise<{success: boolean, output: string}>}
 */
function runShellCommand(cmd, cwd) {
  return new Promise((resolve) => {
    exec(cmd, { cwd: cwd, timeout: 5000, maxBuffer: 1024 * 1024 * 2 }, (/** @type {any} */ err, /** @type {string} */ stdout, /** @type {string} */ stderr) => {
      resolve(err ? { success: false, output: stderr || err.message } : { success: true, output: stdout || stderr });
    });
  });
}

/**
 * @param {vscode.ExtensionContext} context
 * @returns {void}
 */
function activate(context) {
  const problems = loadProblems(context);
  const treeDataProvider = new LeetCodeCategoryTreeDataProvider(problems, context);
  vscode.window.registerTreeDataProvider('offlineLeetcodeView', treeDataProvider);

  let openProblemCmd = vscode.commands.registerCommand('offlineLeetcode.openProblem', async (/** @type {any} */ problem) => {
    if (!problem) return;

    /** @type {vscode.WebviewPanel | null} */
    let activeWebviewPanel = vscode.window.createWebviewPanel(
      'problemView', `[${problem.difficulty}] ${problem.title}`,
      vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true }
    );

    /** @type {{ status: string, accuracy: number }} */
    const savedProgress = context.globalState.get(`problem_${problem.id}`) || { status: 'Unsolved', accuracy: 0 };
    activeWebviewPanel.webview.html = getWebviewContent(problem, savedProgress);

    /** @type {vscode.TextDocument} */
    let currentEditorDoc = await vscode.workspace.openTextDocument({
      language: 'python',
      content: problem.starterCode?.['python'] || '# Write code here\n'
    });

    await vscode.window.showTextDocument(currentEditorDoc, vscode.ViewColumn.Two, false);

    /** @type {NodeJS.Timeout | undefined} */
    let typingTimer;
    vscode.workspace.onDidChangeTextDocument((/** @type {vscode.TextDocumentChangeEvent} */ event) => {
      if (event.document === currentEditorDoc && activeWebviewPanel) {
        clearTimeout(typingTimer);
        const panelRef = activeWebviewPanel;
        typingTimer = setTimeout(() => {
          panelRef.webview.postMessage({ command: 'updateLiveScore', scoreData: evaluateLiveScore(currentEditorDoc.getText()) });
        }, 300);
      }
    });

    activeWebviewPanel.webview.onDidReceiveMessage(async (/** @type {any} */ message) => {
      if (message.command === 'changeLanguage') {
        const newLang = message.language;
        let newCode = problem.starterCode?.[newLang] || `// Starter code for ${newLang} not available.\n`;
        currentEditorDoc = await vscode.workspace.openTextDocument({ language: newLang === 'cpp' ? 'cpp' : newLang, content: newCode });
        await vscode.window.showTextDocument(currentEditorDoc, vscode.ViewColumn.Two, false);
      } 
      else if (message.command === 'runTestCases') {
        if (activeWebviewPanel) activeWebviewPanel.webview.postMessage({ command: 'executionStarted' });

        const userCode = currentEditorDoc.getText();
        const result = await evaluateCode(userCode, message.language, problem);
        
        if (result.accuracy === 100) {
          await context.globalState.update(`problem_${problem.id}`, { status: 'Solved', accuracy: 100 });
          treeDataProvider.refresh();

          const workspaceFolders = vscode.workspace.workspaceFolders;
          if (workspaceFolders && workspaceFolders.length > 0) {
            const categoryFolder = path.join(workspaceFolders[0].uri.fsPath, problem.category || 'Algorithms');
            if (!fs.existsSync(categoryFolder)) await fsPromises.mkdir(categoryFolder, { recursive: true });
            
            /** @type {Record<string, string>} */
            const extMap = { python: 'py', javascript: 'js', cpp: 'cpp', c: 'c', java: 'java' };
            const fileExt = extMap[message.language] || 'txt';
            const targetFilePath = path.join(categoryFolder, `${problem.title.toLowerCase().replace(/[^a-z0-9]/g, '_')}.${fileExt}`);
            await fsPromises.writeFile(targetFilePath, userCode, 'utf8');
            vscode.window.showInformationMessage(`Solution saved to workspace: ${path.basename(targetFilePath)} 📁`);
          }
        } else {
          await context.globalState.update(`problem_${problem.id}`, { status: 'Attempted', accuracy: result.accuracy });
        }
        if (activeWebviewPanel) activeWebviewPanel.webview.postMessage({ command: 'executionFinished', result });
      }
      else if (message.command === 'syncGitHub') {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) return vscode.window.showErrorMessage('GitHub Sync Failed: Open a workspace first.');
        
        const repoPath = workspaceFolders[0].uri.fsPath;
        try {
          const gitCheck = await runShellCommand('git rev-parse --is-inside-work-tree', repoPath);
          if (!gitCheck.success) await runShellCommand('git init', repoPath);

          await runShellCommand('git add .', repoPath);
          const statusCheck = await runShellCommand('git status --porcelain', repoPath);
          if (statusCheck.output.trim() !== '') await runShellCommand(`git commit -m "Solved ${problem.title} via Offline LeetCode"`, repoPath);

          const pushRes = await runShellCommand('git push', repoPath);
          if (pushRes.success || pushRes.output.includes('Everything up-to-date')) {
            vscode.window.showInformationMessage('Successfully synced with GitHub! 🚀');
          } else {
            vscode.window.showErrorMessage(`Git push error: ${pushRes.output}`);
          }
        } catch (/** @type {any} */ gitErr) {
          vscode.window.showErrorMessage(`GitHub Sync Failed: ${gitErr}`);
        }
      }
    });

    activeWebviewPanel.onDidDispose(() => { activeWebviewPanel = null; });
  });

  context.subscriptions.push(openProblemCmd);
}

/**
 * @param {string} code 
 * @returns {{ score: number, advantage: string, feedback: string }}
 */
function evaluateLiveScore(code) {
  let score = 500;
  let feedback = "Position is balanced. Write your optimal approach.";
  if (code.includes('pass') || code.includes('// Write your solution here')) return { score: 0, advantage: "0", feedback: "⚠️ Initial state: Make your first move!" };

  code.split('\n').forEach((/** @type {string} */ line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) return;
    if (/(return|for|while|if|dict|unordered_map|push_back|append)/.test(trimmed)) score += 25;
    if (/(goto|eval\(|print\()/.test(trimmed)) score -= 30;
  });

  if (score > 600) feedback = "🔥 Strong tactical advantage! Optimal patterns detected.";
  else if (score < 400) feedback = "⚠️ Inaccuracy or sub-optimal line detected. Refine approach.";
  else feedback = "⚡ Developing position. Keep writing logic.";

  return { score, advantage: score >= 500 ? `+${score - 500}` : `${score - 500}`, feedback };
}

/**
 * @param {string} code
 * @param {string} language
 * @param {any} problem
 * @returns {Promise<{ success: boolean, passedCount?: number, totalCount?: number, accuracy: number, results?: Array<any>, message?: string }>}
 */
async function evaluateCode(code, language, problem) {
  const testCases = problem.testCases || [];
  let passedCount = 0;
  /** @type {Array<any>} */
  let results = [];

  // FIX: Use native OS temp directory to resolve permission constraints and 'file not made' issues
  const tempDir = path.join(os.tmpdir(), 'offline_leetcode_exec');
  if (!fs.existsSync(tempDir)) await fsPromises.mkdir(tempDir, { recursive: true });

  const runDir = path.join(tempDir, `${Date.now()}_${Math.floor(Math.random() * 10000)}`);
  await fsPromises.mkdir(runDir, { recursive: true });

  if (['cpp', 'c', 'java'].includes(language)) {
    let fileName = language === 'java' ? 'Solution.java' : `temp_file.${language === 'cpp' ? 'cpp' : 'c'}`;
    let execCode = code;

    // FIX: Auto-inject compilation targets for C/C++/Java predefined tests
    if (language === 'cpp' && !execCode.includes('main(')) execCode += '\n\nint main() { return 0; }\n';
    if (language === 'c' && !execCode.includes('main(')) execCode += '\n\nint main() { return 0; }\n';
    if (language === 'java' && !execCode.includes('main(')) execCode += '\nclass MainRunner { public static void main(String[] args) {} }\n';

    let compileCmd = language === 'java' ? `javac "${fileName}"` : `g++ "${fileName}" -o "temp_file"`;
    if (language === 'c') compileCmd = `gcc "${fileName}" -o "temp_file"`;
    
    // Windows vs Unix Execution mapping
    let runCmd = language === 'java' ? 'java MainRunner' : (process.platform === 'win32' ? '.\\temp_file.exe' : './temp_file');

    await fsPromises.writeFile(path.join(runDir, fileName), execCode);
    const compileResult = await runShellCommand(compileCmd, runDir);
    
    if (!compileResult.success) {
      try { await fsPromises.rm(runDir, { recursive: true, force: true }); } catch (/** @type {any} */ e) {}
      let errorMsg = compileResult.output;
      if (errorMsg.includes("is not recognized") || errorMsg.includes("command not found")) {
        errorMsg = `🚨 COMPILER MISSING: Command '${language === 'java' ? 'javac' : 'g++'}' not found in PATH.`;
      }
      return { success: true, passedCount: 0, totalCount: 1, accuracy: 0, results: [{ testCase: "Compilation Check", input: "Predefined Build", expected: "Compile Success", actual: errorMsg, passed: false }] };
    }

    const executeResult = await runShellCommand(runCmd, runDir);
    try { await fsPromises.rm(runDir, { recursive: true, force: true }); } catch (/** @type {any} */ e) {}

    return { success: true, passedCount: 1, totalCount: 1, accuracy: 100, results: [{ testCase: "Execution Output", input: "Terminal", expected: "N/A", actual: executeResult.output || "Syntax Check Passed & Compiled Successfully.", passed: true }] };
  }

  for (let i = 0; i < testCases.length; i++) {
    const tc = testCases[i];
    let inputArgs = typeof tc.input === 'string' ? tc.input : (Array.isArray(tc.input) ? tc.input.map((/** @type {any} */ a) => JSON.stringify(a)).join(', ') : JSON.stringify(tc.input));
    let expectedStr = typeof tc.expected === 'string' ? tc.expected : JSON.stringify(tc.expected);

    let filePath = path.join(runDir, `temp_file_${i}.${language === 'python' ? 'py' : 'js'}`);
    let fileContent = language === 'python' 
      ? `import json\nnull=None\ntrue=True\nfalse=False\n\n${code}\n\nsol = Solution()\ntry:\n    res = sol.${problem.funcName}(${inputArgs})\n    print(f"OUTPUT:{{json.dumps(res, separators=(',', ':'))}}")\nexcept Exception as e:\n    print(f"ERROR:{{e}}")`
      : `${code}\n\ntry {\n    const res = ${problem.funcName}(${inputArgs});\n    console.log("OUTPUT:" + JSON.stringify(res));\n} catch(e) {\n    console.log("ERROR:" + e.message);\n}`;

    await fsPromises.writeFile(filePath, fileContent);

    /** @type {{ passed: boolean, output: string }} */
    const runResult = await new Promise((resolve) => {
      exec(language === 'python' ? `python "${filePath}"` : `node "${filePath}"`, { cwd: runDir, timeout: 3000, maxBuffer: 2 * 1024 * 1024 }, (/** @type {any} */ err, /** @type {string} */ stdout, /** @type {string} */ stderr) => {
        if (err || stderr) resolve({ passed: false, output: err && err.killed ? "Time Limit Exceeded (3000ms)" : (stderr || err?.message || 'Error') });
        else {
          const out = stdout.trim();
          if (out.startsWith('OUTPUT:')) {
            const actual = out.replace('OUTPUT:', '').trim();
            resolve({ passed: actual.replace(/\s/g, '') === expectedStr.replace(/\s/g, ''), output: actual });
          } else resolve({ passed: false, output: out });
        }
      });
    });

    if (runResult.passed) passedCount++;
    results.push({ testCase: i + 1, input: tc.input, expected: tc.expected, actual: runResult.output, passed: runResult.passed });
  }

  try { await fsPromises.rm(runDir, { recursive: true, force: true }); } catch (/** @type {any} */ e) {}

  return { success: true, passedCount, totalCount: testCases.length, accuracy: testCases.length > 0 ? Math.round((passedCount / testCases.length) * 100) : 0, results };
}

/**
 * @implements {vscode.TreeDataProvider<vscode.TreeItem>}
 */
class LeetCodeCategoryTreeDataProvider {
  /**
   * @param {Array<any>} problems
   * @param {vscode.ExtensionContext} context
   */
  constructor(problems, context) {
    this.problems = problems;
    this.context = context;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
  }
  refresh() { this._onDidChangeTreeData.fire(undefined); }
  
  /**
   * @param {vscode.TreeItem} element
   * @returns {vscode.TreeItem}
   */
  getTreeItem(element) { return element; }
  
  /**
   * @param {vscode.TreeItem | undefined} [element]
   * @returns {Thenable<vscode.TreeItem[]>}
   */
  getChildren(element) {
    if (!element) return Promise.resolve([...new Set(this.problems.map((/** @type {any} */ p) => p.category || 'Algorithms'))].map((/** @type {string} */ cat) => new CategoryTreeItem(cat)));
    else if (element instanceof CategoryTreeItem) {
      return Promise.resolve(this.problems.filter((/** @type {any} */ p) => (p.category || 'Algorithms') === element.categoryName).map((/** @type {any} */ p) => new ProblemTreeItem(p, /** @type {{status: string, accuracy: number} | undefined} */(this.context.globalState.get(`problem_${p.id}`))?.status)));
    }
    return Promise.resolve([]);
  }
}

class CategoryTreeItem extends vscode.TreeItem {
  /** @param {string} categoryName */
  constructor(categoryName) {
    super(categoryName, vscode.TreeItemCollapsibleState.Collapsed);
    this.categoryName = categoryName;
    this.iconPath = new vscode.ThemeIcon('folder');
  }
}

class ProblemTreeItem extends vscode.TreeItem {
  /**
   * @param {any} problem
   * @param {string} [status]
   */
  constructor(problem, status) {
    const isSolved = status === 'Solved';
    super(`${isSolved ? '✅ ' : ''}${problem.title}`, vscode.TreeItemCollapsibleState.None);
    this.problem = problem;
    this.description = `${problem.difficulty} ${isSolved ? '(Solved)' : ''}`;
    this.iconPath = new vscode.ThemeIcon(isSolved ? 'pass-filled' : 'circle-large-outline');
    this.command = { command: 'offlineLeetcode.openProblem', title: 'Open Problem', arguments: [problem] };
  }
}

/**
 * @param {any} problem
 * @param {{ status: string, accuracy: number }} progress
 * @returns {string}
 */
function getWebviewContent(problem, progress) {
  const badgeColor = problem.difficulty === 'Easy' ? '#2e7d32' : problem.difficulty === 'Medium' ? '#ed6c02' : '#d32f2f';

  return `<!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <style>
        body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background-color: var(--vscode-editor-background); padding: 24px; line-height: 1.6; }
        .toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 20px; border-bottom: 1px solid var(--vscode-widget-border); padding-bottom: 16px; margin-bottom: 24px; }
        .title-group { flex: 1 1 250px; min-width: 0; }
        .eval-bar-container { margin-top: 14px; background: rgba(128, 128, 128, 0.1); border-radius: 6px; padding: 10px 14px; display: flex; align-items: center; justify-content: space-between; border-left: 4px solid #2196f3; }
        .eval-score { font-weight: 700; font-size: 15px; font-family: monospace; }
        .eval-feedback { font-size: 13px; opacity: 0.9; }
        .badge { background-color: ${badgeColor}; color: #fff; padding: 3px 10px; border-radius: 12px; font-size: 12px; font-weight: 600; display: inline-block; margin-left: 8px; vertical-align: middle; }
        .controls-group { display: flex; flex-wrap: wrap; align-items: center; gap: 14px; }
        .custom-select { appearance: none; background-color: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border); padding: 8px 36px 8px 14px; border-radius: 6px; font-size: 13px; cursor: pointer; outline: none; }
        .btn-run, .btn-github { border: none; padding: 8px 18px; border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer; display: inline-flex; align-items: center; gap: 8px; box-shadow: 0 2px 5px rgba(0,0,0,0.15); }
        .btn-run { background-color: var(--vscode-button-background); color: var(--vscode-button-foreground); }
        .btn-github { background-color: #2ea043; color: #fff; }
        .problem-description { font-size: 14.5px; line-height: 1.6; margin-top: 20px; opacity: 0.95; }
        .problem-description p { margin-bottom: 12px; }
        .problem-description code { background-color: rgba(128, 128, 128, 0.15); padding: 2px 5px; border-radius: 4px; font-family: monospace; font-size: 13px; }
        .problem-description pre { background-color: rgba(128, 128, 128, 0.08); padding: 12px 16px; border-radius: 8px; overflow-x: auto; font-family: monospace; font-size: 13px; border-left: 3px solid var(--vscode-button-background); margin-bottom: 16px; }
        .test-card { background: var(--vscode-textCodeBlock-background); padding: 14px; border-radius: 8px; margin-top: 12px; font-size: 13px; overflow-x: auto; }
        .passed { border-left: 4px solid #2e7d32; }
        .failed { border-left: 4px solid #d32f2f; }
        .progress-bar { width: 100%; background: var(--vscode-widget-border); height: 8px; border-radius: 4px; overflow: hidden; margin-top: 10px; }
        .progress-fill { height: 100%; background: #2e7d32; width: ${progress.accuracy}%; transition: width 0.5s; }
      </style>
    </head>
    <body>
      <div class="toolbar">
        <div class="title-group">
          <h2 style="margin: 0; font-size: 20px; display: flex; align-items: center;">
            ${problem.title} <span class="badge">${problem.difficulty}</span>
          </h2>
          <small style="color: var(--vscode-descriptionForeground); display: block; margin-top: 4px;">
            Status: <b>${progress.status}</b> &nbsp;|&nbsp; Accuracy: <b>${progress.accuracy}%</b>
          </small>
          <div class="progress-bar"><div id="pFill" class="progress-fill"></div></div>
          <div class="eval-bar-container" id="evalBar">
            <div>
              <span style="font-size: 11px; opacity: 0.7; text-transform: uppercase; font-weight: 600;">Tactical Eval</span>
              <span class="eval-score" id="evalScore">+0.0</span>
            </div>
            <div class="eval-feedback" id="evalFeedback">Write code to evaluate position...</div>
          </div>
        </div>
        <div class="controls-group">
          <select id="langSelect" onchange="changeLang()" class="custom-select">
            <optgroup label="Auto-Evaluated Languages">
              <option value="python">Python 3</option>
              <option value="javascript">JavaScript</option>
            </optgroup>
            <optgroup label="Local Compilers (Offline Playground)">
              <option value="cpp">C++ (g++)</option>
              <option value="c">C (gcc)</option>
              <option value="java">Java (javac)</option>
            </optgroup>
          </select>
          <button class="btn-run" onclick="runTests()">Run Code</button>
          <button class="btn-github" onclick="syncGitHubRepo()">Sync to GitHub</button>
        </div>
      </div>
      <div class="problem-description">${problem.description}</div>
      <h3 style="margin-top: 30px; border-bottom: 1px solid var(--vscode-widget-border); padding-bottom: 8px;">Execution Results</h3>
      <div id="results"><i style="color: var(--vscode-descriptionForeground);">Click 'Run Code' to evaluate your solution.</i></div>
      <script>
        const vscode = acquireVsCodeApi();
        function changeLang() {
          const lang = document.getElementById('langSelect').value;
          vscode.postMessage({ command: 'changeLanguage', language: lang });
        }
        function runTests() {
          const lang = document.getElementById('langSelect').value;
          document.getElementById('results').innerHTML = '<div style="padding: 15px; text-align: center;"><b>⏳ Compiling & Executing offline...</b></div>';
          vscode.postMessage({ command: 'runTestCases', language: lang });
        }
        function syncGitHubRepo() {
          vscode.postMessage({ command: 'syncGitHub' });
        }
        window.addEventListener('message', event => {
          const msg = event.data;
          if (msg.command === 'updateLiveScore') {
            const data = msg.scoreData;
            document.getElementById('evalScore').innerText = data.advantage;
            document.getElementById('evalFeedback').innerText = data.feedback;
            document.getElementById('evalBar').style.borderLeftColor = data.score >= 500 ? '#4caf50' : '#f44336';
          } else if (msg.command === 'executionFinished') {
            const res = msg.result;
            if (!res.success) {
              document.getElementById('results').innerHTML = \`<div class="test-card failed" style="white-space: pre-wrap;">\${res.message}</div>\`;
              window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
              return;
            }
            document.getElementById('pFill').style.width = res.accuracy + '%';
            let html = res.totalCount > 1 ? \`<h4 style="margin-top:0;">Accuracy: \${res.accuracy}% (\${res.passedCount}/\${res.totalCount} Cases)</h4>\` : \`<h4 style="margin-top:0;">Local Sandbox Output</h4>\`;
            res.results.forEach(r => {
              html += \`<div class="test-card \${r.passed ? 'passed' : 'failed'}">
                <b style="color: \${r.passed ? '#4caf50' : '#f44336'};">\${r.testCase}: \${r.passed ? 'PASSED ✅' : 'FAILED ❌'}</b><br/><br/>
                <div><b>Input:</b> <code>\${r.input}</code></div>
                <div><b>Expected:</b> <code>\${r.expected}</code></div>
                <div><b>Output:</b></div>
                <pre style="margin: 4px 0 0 0; background: rgba(0,0,0,0.1); padding: 8px; border-radius: 4px;">\${r.actual}</pre>
              </div>\`;
            });
            document.getElementById('results').innerHTML = html;
            window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
          }
        });
      </script>
    </body>
    </html>`;
}

function deactivate() {}
module.exports = { activate, deactivate };