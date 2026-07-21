const vscode = require('vscode');
const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');
const { exec } = require('child_process');

/**
 * @param {vscode.ExtensionContext} context
 * @returns {Array<any>}
 */
function loadProblems(context) {
  try {
    const jsonPath = path.join(context.extensionPath, 'data', 'problems.json');
    if (!fs.existsSync(jsonPath)) return [];
    const rawData = fs.readFileSync(jsonPath, 'utf8');
    return JSON.parse(rawData);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Offline LeetCode: Failed to load dataset. ${errMsg}`);
    return [];
  }
}

/**
 * Executes compilation commands locally
 * @param {string} cmd 
 * @returns {Promise<{success: boolean, output: string}>}
 */
function runShellCommand(cmd) {
  return new Promise((resolve) => {
    exec(cmd, { timeout: 5000, maxBuffer: 1024 * 1024 * 2 }, (err, stdout, stderr) => {
      if (err) {
        resolve({ success: false, output: stderr || err.message });
      } else {
        resolve({ success: true, output: stdout || stderr });
      }
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

  let openProblemCmd = vscode.commands.registerCommand('offlineLeetcode.openProblem', async (problem) => {
    if (!problem) return;

    /** @type {vscode.WebviewPanel | null} */
    let activeWebviewPanel = vscode.window.createWebviewPanel(
      'problemView',
      `[${problem.difficulty}] ${problem.title}`,
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    /** @type {{ status: string, accuracy: number }} */
    const savedProgress = context.globalState.get(`problem_${problem.id}`) || { status: 'Unsolved', accuracy: 0 };
    activeWebviewPanel.webview.html = getWebviewContent(problem, savedProgress);

    const initialLang = 'python';
    /** @type {vscode.TextDocument} */
    let currentEditorDoc = await vscode.workspace.openTextDocument({
      language: initialLang,
      content: problem.starterCode?.[initialLang] || '# Write code here\n'
    });

    await vscode.window.showTextDocument(currentEditorDoc, vscode.ViewColumn.Two, false);

    activeWebviewPanel.webview.onDidReceiveMessage(async (message) => {
      if (message.command === 'changeLanguage') {
        const newLang = message.language;
        let newCode = problem.starterCode?.[newLang] || `// Starter code for ${newLang} not available.\n// Please write your solution below.`;
        
        // Add basic main function templates for compiled languages to guide the user
        if (newLang === 'cpp' && !newCode.includes('main')) {
            newCode += `\n\nint main() {\n    // Write your test cases here\n    Solution sol;\n    return 0;\n}`;
        } else if (newLang === 'java' && !newCode.includes('main')) {
            newCode = `public class Solution {\n    // Problem logic\n\n    public static void main(String[] args) {\n        // Write your test cases here\n    }\n}`;
        }

        currentEditorDoc = await vscode.workspace.openTextDocument({
          language: newLang === 'cpp' ? 'cpp' : newLang,
          content: newCode
        });
        await vscode.window.showTextDocument(currentEditorDoc, vscode.ViewColumn.Two, false);
      } 
      else if (message.command === 'runTestCases') {
        const userCode = currentEditorDoc ? currentEditorDoc.getText() : '';
        const language = message.language;
        
        if (activeWebviewPanel) {
          activeWebviewPanel.webview.postMessage({ command: 'executionStarted' });
        }

        const result = await evaluateCode(userCode, language, problem);
        
        if (result.accuracy === 100) {
          await context.globalState.update(`problem_${problem.id}`, { status: 'Solved', accuracy: 100 });
          treeDataProvider.refresh();
        } else {
          await context.globalState.update(`problem_${problem.id}`, { status: 'Attempted', accuracy: result.accuracy });
        }

        if (activeWebviewPanel) {
          activeWebviewPanel.webview.postMessage({ command: 'executionFinished', result });
        }
      }
    });

    activeWebviewPanel.onDidDispose(() => {
      activeWebviewPanel = null;
    });
  });

  context.subscriptions.push(openProblemCmd);
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

  const tempDir = path.join(__dirname, 'temp_exec');
  if (!fs.existsSync(tempDir)) {
    await fsPromises.mkdir(tempDir, { recursive: true });
  }

  // Generate a totally unique sub-folder for every execution to prevent clashes
  const runId = Date.now().toString() + '_' + Math.floor(Math.random() * 10000);
  const runDir = path.join(tempDir, runId);
  await fsPromises.mkdir(runDir, { recursive: true });

  // 100% OFFLINE COMPILED LANGUAGES (Playground Mode)
  if (['cpp', 'c', 'java'].includes(language)) {
    let fileName = '';
    let compileCmd = '';
    let runCmd = '';

    if (language === 'cpp') {
      fileName = 'main.cpp';
      const exeName = process.platform === 'win32' ? 'main.exe' : './main';
      compileCmd = `g++ "${path.join(runDir, fileName)}" -o "${path.join(runDir, exeName)}"`;
      runCmd = `"${path.join(runDir, exeName)}"`;
    } else if (language === 'c') {
      fileName = 'main.c';
      const exeName = process.platform === 'win32' ? 'main.exe' : './main';
      compileCmd = `gcc "${path.join(runDir, fileName)}" -o "${path.join(runDir, exeName)}"`;
      runCmd = `"${path.join(runDir, exeName)}"`;
    } else if (language === 'java') {
      fileName = 'Solution.java';
      compileCmd = `javac "${path.join(runDir, fileName)}"`;
      runCmd = `java -cp "${runDir}" Solution`;
    }

    await fsPromises.writeFile(path.join(runDir, fileName), code);

    // Compile Step
    const compileResult = await runShellCommand(compileCmd);
    if (!compileResult.success) {
      // Clean up and return compiler error
      try { await fsPromises.rm(runDir, { recursive: true, force: true }); } catch (e) {}
      
      let errorMsg = compileResult.output;
      if (errorMsg.includes("is not recognized") || errorMsg.includes("command not found")) {
        errorMsg = `🚨 COMPILER MISSING: Your computer does not have '${language === 'java' ? 'javac' : 'g++'}' installed or added to PATH.\nPlease install the local compiler to run this offline.`;
      }

      return {
        success: true, passedCount: 0, totalCount: 1, accuracy: 0,
        results: [{
          testCase: "Local Compilation", input: "Code Build", expected: "Compile Successfully",
          actual: errorMsg, passed: false
        }]
      };
    }

    // Execution Step
    const executeResult = await runShellCommand(runCmd);
    
    // Cleanup
    try { await fsPromises.rm(runDir, { recursive: true, force: true }); } catch (e) {}

    return {
      success: true, passedCount: 0, totalCount: 1, accuracy: 0,
      results: [{
        testCase: "Local Execution Output", input: "Terminal Execution", expected: "N/A (Playground Mode)",
        actual: executeResult.output || "Program finished with no output.", passed: false
      }]
    };
  }

  // OFFLINE SCRIPTING LANGUAGES (Python / Javascript) with Auto-Tests
  for (let i = 0; i < testCases.length; i++) {
    const tc = testCases[i];
    let fileContent = '';
    let filePath = '';
    let execCmd = '';

    if (language === 'python') {
      filePath = path.join(runDir, `run_${i}.py`);
      fileContent = `${code}\n\nsol = Solution()\ntry:\n    res = sol.${problem.funcName}(${tc.input})\n    print(f"OUTPUT:{res}")\nexcept Exception as e:\n    print(f"ERROR:{e}")`;
      execCmd = `python "${filePath}"`;
    } else if (language === 'javascript') {
      filePath = path.join(runDir, `run_${i}.js`);
      fileContent = `${code}\n\ntry {\n    const res = ${problem.funcName}(${tc.input});\n    console.log("OUTPUT:" + JSON.stringify(res));\n} catch(e) {\n    console.log("ERROR:" + e.message);\n}`;
      execCmd = `node "${filePath}"`;
    }

    await fsPromises.writeFile(filePath, fileContent);

    /** @type {{ passed: boolean, output: string }} */
    const runResult = await new Promise((resolve) => {
      exec(execCmd, { timeout: 3000, maxBuffer: 1024 * 1024 * 2 }, (err, stdout, stderr) => {
        if (err || stderr) {
          if (err && err.killed) {
            resolve({ passed: false, output: "Execution Error: Time Limit Exceeded (3000ms)" });
          } else {
            resolve({ passed: false, output: stderr || (err ? err.message : 'Execution Error') });
          }
        } else {
          const out = stdout.trim();
          if (out.startsWith('OUTPUT:')) {
            const actual = out.replace('OUTPUT:', '').trim();
            const expected = String(tc.expected).trim();
            resolve({ passed: actual === expected, output: actual });
          } else {
            resolve({ passed: false, output: out });
          }
        }
      });
    });

    if (runResult.passed) passedCount++;
    results.push({
      testCase: i + 1,
      input: tc.input,
      expected: tc.expected,
      actual: runResult.output,
      passed: runResult.passed
    });
  }

  // Cleanup after loop finishes
  try { await fsPromises.rm(runDir, { recursive: true, force: true }); } catch (e) {}

  return {
    success: true,
    passedCount,
    totalCount: testCases.length,
    accuracy: testCases.length > 0 ? Math.round((passedCount / testCases.length) * 100) : 0,
    results
  };
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

  refresh() {
    this._onDidChangeTreeData.fire(undefined);
  }

  /**
   * @param {vscode.TreeItem} element
   * @returns {vscode.TreeItem}
   */
  getTreeItem(element) { return element; }

  /**
   * @param {vscode.TreeItem} [element]
   * @returns {Thenable<vscode.TreeItem[]>}
   */
  getChildren(element) {
    if (!element) {
      const categories = [...new Set(this.problems.map(p => p.category || 'Algorithms'))];
      return Promise.resolve(categories.map(cat => new CategoryTreeItem(cat)));
    } else if (element instanceof CategoryTreeItem) {
      const categoryProblems = this.problems.filter(p => (p.category || 'Algorithms') === element.categoryName);
      return Promise.resolve(categoryProblems.map(p => {
        /** @type {{ status: string, accuracy: number } | undefined} */
        const prog = this.context.globalState.get(`problem_${p.id}`);
        return new ProblemTreeItem(p, prog?.status);
      }));
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
    this.command = {
      command: 'offlineLeetcode.openProblem',
      title: 'Open Problem',
      arguments: [problem]
    };
  }
}

/**
 * @param {any} problem
 * @param {{ status: string, accuracy: number }} progress
 * @returns {string}
 */
function getWebviewContent(problem, progress) {
  const badgeColor = problem.difficulty === 'Easy' ? '#2e7d32' : problem.difficulty === 'Medium' ? '#ed6c02' : '#d32f2f';

  return /* html */ `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <style>
        body {
          font-family: var(--vscode-font-family);
          color: var(--vscode-foreground);
          background-color: var(--vscode-editor-background);
          padding: 24px;
          line-height: 1.6;
        }
        .toolbar {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          justify-content: space-between;
          gap: 20px;
          border-bottom: 1px solid var(--vscode-widget-border);
          padding-bottom: 16px;
          margin-bottom: 24px;
        }
        .title-group {
          flex: 1 1 250px;
          min-width: 0;
        }
        .badge {
          background-color: ${badgeColor};
          color: #ffffff;
          padding: 3px 10px;
          border-radius: 12px;
          font-size: 12px;
          font-weight: 600;
          display: inline-block;
          margin-left: 8px;
          vertical-align: middle;
        }
        .controls-group {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 14px;
        }
        .custom-select-wrapper {
          position: relative;
          display: flex;
          align-items: center;
        }
        .custom-select {
          appearance: none;
          -webkit-appearance: none;
          background-color: var(--vscode-dropdown-background);
          color: var(--vscode-dropdown-foreground);
          border: 1px solid var(--vscode-dropdown-border, var(--vscode-widget-border));
          padding: 8px 36px 8px 14px;
          border-radius: 6px;
          font-family: inherit;
          font-size: 13px;
          font-weight: 500;
          cursor: pointer;
          outline: none;
          box-shadow: 0 1px 3px rgba(0,0,0,0.1);
          transition: border-color 0.2s, box-shadow 0.2s;
        }
        .custom-select:focus {
          border-color: var(--vscode-focusBorder);
          box-shadow: 0 0 0 2px rgba(var(--vscode-focusBorder), 0.2);
        }
        .custom-select-icon {
          position: absolute;
          right: 12px;
          top: 50%;
          transform: translateY(-50%);
          pointer-events: none;
          fill: var(--vscode-dropdown-foreground);
          opacity: 0.7;
        }
        .btn-run {
          background-color: var(--vscode-button-background);
          color: var(--vscode-button-foreground);
          border: none;
          padding: 8px 18px;
          border-radius: 6px;
          font-family: inherit;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          gap: 8px;
          transition: background-color 0.2s, transform 0.1s;
          box-shadow: 0 2px 5px rgba(0,0,0,0.15);
        }
        .btn-run:hover {
          background-color: var(--vscode-button-hoverBackground);
        }
        .btn-run:active {
          transform: translateY(1px);
        }
        .test-card {
          background: var(--vscode-textCodeBlock-background);
          padding: 14px;
          border-radius: 8px;
          margin-top: 12px;
          font-size: 13px;
          box-shadow: 0 1px 3px rgba(0,0,0,0.05);
          overflow-x: auto;
        }
        .passed { border-left: 4px solid #2e7d32; }
        .failed { border-left: 4px solid #d32f2f; }
        .progress-bar {
          width: 100%;
          background: var(--vscode-widget-border);
          height: 8px;
          border-radius: 4px;
          overflow: hidden;
          margin-top: 10px;
        }
        .progress-fill {
          height: 100%;
          background: #2e7d32;
          width: ${progress.accuracy}%;
          transition: width 0.5s cubic-bezier(0.4, 0, 0.2, 1);
        }
      </style>
    </head>
    <body>
      <div class="toolbar">
        <div class="title-group">
          <h2 style="margin: 0; font-size: 20px; line-height: 1.3; display: flex; align-items: center;">
            ${problem.title} <span class="badge">${problem.difficulty}</span>
          </h2>
          <small style="color: var(--vscode-descriptionForeground); display: block; margin-top: 4px;">
            Status: <b style="color: var(--vscode-foreground);">${progress.status}</b> &nbsp;|&nbsp; 
            Accuracy: <b style="color: var(--vscode-foreground);">${progress.accuracy}%</b>
          </small>
          <div class="progress-bar"><div id="pFill" class="progress-fill"></div></div>
        </div>

        <div class="controls-group">
          <div class="custom-select-wrapper">
            <select id="langSelect" onchange="changeLang()" class="custom-select">
              <optgroup label="Auto-Evaluated Languages">
                <option value="python">Python 3</option>
                <option value="javascript">JavaScript</option>
              </optgroup>
              <optgroup label="Local Compilers (Offline Playground)">
                <option value="cpp">C++ (Requires g++)</option>
                <option value="c">C (Requires gcc)</option>
                <option value="java">Java (Requires javac)</option>
              </optgroup>
            </select>
            <svg class="custom-select-icon" width="10" height="6" viewBox="0 0 10 6" xmlns="http://www.w3.org/2000/svg">
              <path d="M1 1L5 5L9 1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </div>
          <button class="btn-run" onclick="runTests()">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg> 
            Run Code
          </button>
        </div>
      </div>

      <div style="font-size: 14px; opacity: 0.9;">${problem.description}</div>

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

        window.addEventListener('message', event => {
          const msg = event.data;
          if (msg.command === 'executionFinished') {
            const res = msg.result;
            if (!res.success) {
              document.getElementById('results').innerHTML = \`<div class="test-card failed" style="white-space: pre-wrap;">\${res.message}</div>\`;
              return;
            }
            document.getElementById('pFill').style.width = res.accuracy + '%';
            
            let html = res.totalCount > 1 
              ? \`<h4 style="margin-top:0;">Accuracy: \${res.accuracy}% (\${res.passedCount}/\${res.totalCount} Cases)</h4>\`
              : \`<h4 style="margin-top:0;">Local Sandbox Output</h4>\`;
              
            res.results.forEach(r => {
              html += \`
                <div class="test-card \${r.passed ? 'passed' : 'failed'}">
                  <b style="color: \${r.passed ? '#4caf50' : '#f44336'};">\${r.testCase}: \${r.passed ? 'PASSED ✅' : (r.expected === 'N/A (Playground Mode)' ? 'FINISHED 🏁' : 'FAILED ❌')}</b><br/><br/>
                  <div style="opacity: 0.8; margin-bottom: 4px;"><b>Input:</b> <code>\${r.input}</code></div>
                  <div style="opacity: 0.8; margin-bottom: 4px;"><b>Expected:</b> <code>\${r.expected}</code></div>
                  <div style="opacity: 0.8;"><b>Output:</b></div>
                  <pre style="margin: 4px 0 0 0; background: rgba(0,0,0,0.1); padding: 8px; border-radius: 4px;">\${r.actual}</pre>
                </div>
              \`;
            });
            document.getElementById('results').innerHTML = html;
          }
        });
      </script>
    </body>
    </html>
  `;
}

function deactivate() {}

module.exports = { activate, deactivate };