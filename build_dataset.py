import json
import urllib.request
import os
import concurrent.futures

print("Fetching LeetCode problem metadata...")

LEETCODE_API_URL = "https://leetcode.com/api/problems/all/"
headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json',
    'Content-Type': 'application/json'
}

try:
    req = urllib.request.Request(LEETCODE_API_URL, headers={'User-Agent': headers['User-Agent']})
    with urllib.request.urlopen(req, timeout=10) as response:
        data = json.loads(response.read().decode('utf-8'))

    pairs = data.get("stat_status_pairs", [])
    total_problems = len(pairs)
    print(f"Found {total_problems} problems. Fetching precise boilerplate and test cases (multithreaded)...")

    difficulty_map = {1: "Easy", 2: "Medium", 3: "Hard"}
    formatted_problems = []

    def fetch_problem_data(item):
        stat = item.get("stat", {})
        problem_id = str(stat.get("frontend_question_id", ""))
        title = stat.get("question__title", "Untitled Problem")
        title_slug = stat.get("question__title_slug", "")
        
        raw_func_name = title_slug.replace('-', '_') if title_slug else f"problem_{problem_id}"
        func_name = f"problem_{raw_func_name}" if raw_func_name and raw_func_name[0].isdigit() else raw_func_name
        difficulty = difficulty_map.get(item.get("difficulty", {}).get("level", 1), "Easy")

        # Categorize
        category = "Algorithms"
        title_lower = title.lower()
        if any(w in title_lower for w in ["tree", "bst"]): category = "Trees"
        elif any(w in title_lower for w in ["link", "node", "list"]): category = "Linked List"
        elif any(w in title_lower for w in ["graph", "path", "bfs", "dfs"]): category = "Graphs"
        elif any(w in title_lower for w in ["array", "matrix", "subarray"]): category = "Arrays & Hashing"

        question_description = ""
        question_code_snippets = {}
        sample_cases = []

        if title_slug:
            graphql_url = "https://leetcode.com/graphql"
            payload = {
                "query": """
                    query questionData($titleSlug: String!) {
                        question(titleSlug: $titleSlug) {
                            content
                            codeSnippets { lang langSlug code }
                            exampleTestcases
                            metaData
                        }
                    }
                """,
                "variables": {"titleSlug": title_slug}
            }
            
            try:
                gql_req = urllib.request.Request(graphql_url, data=json.dumps(payload).encode('utf-8'), headers=headers)
                with urllib.request.urlopen(gql_req, timeout=5) as gql_resp:
                    q_data = json.loads(gql_resp.read().decode('utf-8')).get("data", {}).get("question")
                    if q_data:
                        question_description = q_data.get("content", "")
                        for snip in q_data.get("codeSnippets", []):
                            slug = snip.get("langSlug")
                            if slug in ["python", "python3"]: question_code_snippets["python"] = snip.get("code")
                            elif slug in ["javascript", "cpp", "c", "java"]: question_code_snippets[slug] = snip.get("code")
                        
                        raw_tc = q_data.get("exampleTestcases", "")
                        meta_data_str = q_data.get("metaData", "{}")
                        try:
                            meta_data = json.loads(meta_data_str)
                            if raw_tc and "params" in meta_data:
                                num_params = len(meta_data["params"])
                                lines = [l.strip() for l in raw_tc.split('\n') if l.strip()]
                                for i in range(0, len(lines), num_params):
                                    tc_args = lines[i:i+num_params]
                                    if tc_args:
                                        sample_cases.append({"id": (i // num_params) + 1, "input": ", ".join(tc_args), "expected": "Run to evaluate"})
                        except:
                            pass
            except Exception:
                pass 

        if not sample_cases:
            sample_cases = [{"id": 1, "input": "[2, 7, 11, 15], 9", "expected": "[0, 1]"}]

        starter_code = {
            "python": question_code_snippets.get("python", f"class Solution:\n    def {func_name}(self, nums, target):\n        pass\n"),
            "javascript": question_code_snippets.get("javascript", f"var {func_name} = function(nums, target) {{\n}};\n"),
            "cpp": question_code_snippets.get("cpp", f"class Solution {{\npublic:\n    void {func_name}() {{}}\n}};\n"),
            "c": question_code_snippets.get("c", f"void {func_name}() {{}}\n"),
            "java": question_code_snippets.get("java", f"class Solution {{\n    public void {func_name}() {{}}\n}}\n")
        }

        description = question_description if question_description else f"<p>Given the problem <b>'{title}'</b> on LeetCode.</p>"

        return {
            "id": problem_id, "title": title, "difficulty": difficulty, "category": category,
            "funcName": func_name, "description": description, "starterCode": starter_code,
            "testCases": sample_cases, "solution": f"<h3>General Approach</h3><p>Analyze constraints.</p>"
        }

    with concurrent.futures.ThreadPoolExecutor(max_workers=15) as executor:
        futures = {executor.submit(fetch_problem_data, item): item for item in pairs}
        completed_count = 0
        for future in concurrent.futures.as_completed(futures):
            result = future.result()
            if result: formatted_problems.append(result)
            completed_count += 1
            if completed_count % 100 == 0 or completed_count == total_problems:
                print(f"Processed {completed_count}/{total_problems} problems...")

    formatted_problems.sort(key=lambda x: int(x["id"]) if x["id"].isdigit() else 99999)

    base_dir = os.path.dirname(os.path.abspath(__file__))
    data_dir = os.path.join(base_dir, "data")
    os.makedirs(data_dir, exist_ok=True)
    out_file = os.path.join(data_dir, "problems.json")

    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(formatted_problems, f, indent=2, ensure_ascii=False)

    print(f"✅ Successfully built dataset '{out_file}'!")

except Exception as e:
    print(f"❌ Error building dataset: {e}")