import json
import urllib.request
import os

print("Fetching LeetCode problem metadata...")

# Official LeetCode public API endpoint
LEETCODE_API_URL = "https://leetcode.com/api/problems/all/"

headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json'
}

try:
    req = urllib.request.Request(LEETCODE_API_URL, headers=headers)
    with urllib.request.urlopen(req) as response:
        data = json.loads(response.read().decode('utf-8'))

    pairs = data.get("stat_status_pairs", [])
    print(f"Found {len(pairs)} problems. Processing dataset...")

    difficulty_map = {1: "Easy", 2: "Medium", 3: "Hard"}
    formatted_problems = []

    for item in pairs:
        stat = item.get("stat", {})
        problem_id = str(stat.get("frontend_question_id", ""))
        title = stat.get("question__title", "Untitled Problem")
        title_slug = stat.get("question__title_slug", "")
        func_name = title_slug.replace('-', '_') if title_slug else f"problem_{problem_id}"

        diff_level = item.get("difficulty", {}).get("level", 1)
        difficulty = difficulty_map.get(diff_level, "Easy")

        # Categorize logically based on title keywords
        category = "Algorithms"
        title_lower = title.lower()
        if any(w in title_lower for w in ["tree", "binary tree", "bst"]):
            category = "Trees"
        elif any(w in title_lower for w in ["link", "node", "list"]):
            category = "Linked List"
        elif any(w in title_lower for w in ["graph", "island", "path", "bfs", "dfs"]):
            category = "Graphs"
        elif any(w in title_lower for w in ["array", "sum", "matrix", "subarray"]):
            category = "Arrays & Hashing"
        elif any(w in title_lower for w in ["string", "palindrome", "anagram"]):
            category = "Strings"
        elif any(w in title_lower for w in ["dp", "coin", "subsequence"]):
            category = "Dynamic Programming"

        # Starter Code Templates for Multi-Language Support
        starter_code = {
            "python": f"class Solution:\n    def {func_name}(self, nums, target):\n        # Write your solution here\n        pass\n",
            "javascript": f"/**\n * @param {{any}} nums\n * @param {{any}} target\n * @return {{any}}\n */\nvar {func_name} = function(nums, target) {{\n    // Write your JS solution here\n}};\n",
            "cpp": f"#include <iostream>\n#include <vector>\nusing namespace std;\n\nclass Solution {{\npublic:\n    void {func_name}() {{\n        // Write your C++ solution here\n    }}\n}};\n"
        }

        # Structure Sample Test Cases for Evaluation Engine
        sample_cases = [
            { "id": 1, "input": "[2, 7, 11, 15], 9", "expected": "[0, 1]" },
            { "id": 2, "input": "[3, 2, 4], 6", "expected": "[1, 2]" },
            { "id": 3, "input": "[3, 3], 6", "expected": "[0, 1]" }
        ]

        description = (
            f"Given problem <b>'{title}'</b> on LeetCode.<br/><br/>"
            f"<i>Problem Slug:</i> <code>{title_slug}</code><br/>"
            f"<i>Difficulty:</i> <b>{difficulty}</b><br/><br/>"
            f"Solve using optimal algorithm choices."
        )

        formatted_problems.append({
            "id": problem_id,
            "title": title,
            "difficulty": difficulty,
            "category": category,
            "funcName": func_name,
            "description": description,
            "starterCode": starter_code,
            "testCases": sample_cases,
            "solution": f"<h3>General Approach</h3><p>Analyze constraints and use suitable data structures (e.g. Hash Maps, Two Pointers, or DFS/BFS).</p>"
        })

    # Sort problems by Frontend ID numerically
    formatted_problems.sort(key=lambda x: int(x["id"]) if x["id"].isdigit() else 99999)

    # Save to data/problems.json
    os.makedirs("data", exist_ok=True)
    out_file = os.path.join("data", "problems.json")

    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(formatted_problems, f, indent=2, ensure_ascii=False)

    print(f"✅ Successfully created '{out_file}' with {len(formatted_problems)} questions!")

except Exception as e:
    print(f"❌ Error building dataset: {e}")