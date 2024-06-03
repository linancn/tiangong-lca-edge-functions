import SearchApi from "npm:duckduckgo-search@1.0.5";
import { DynamicTool } from "https://esm.sh/@langchain/core@0.2.5/tools";

class searchInternetTool {
    maxResults: number;

    constructor(maxResults: number = 1) {
        this.maxResults = maxResults;
    }

    async search(query: string) {
        const res = [];
        let count = 0;
        for await (const result of SearchApi.text(query)) {
            res.push(result)
            count++;
            if (count >= this.maxResults) {
                break;
            }
        }
        return res;
    }

    invoke() {
        return new DynamicTool({
            name: "Search_Internet_Tool",
            description: "Call this tool to search the internet for information.",
            func: async (query: string) => {
                if (!query) {
                    throw new Error("Query is required");
                }
                const results = await this.search(query);
                return JSON.stringify(results); // 将结果转换为字符串
            }
        });
    }
}

export default searchInternetTool