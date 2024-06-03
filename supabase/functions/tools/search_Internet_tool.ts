import SearchApi from "https://esm.sh/duckduckgo-search@1.0.5";


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
}

export default searchInternetTool