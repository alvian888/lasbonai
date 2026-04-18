import { scanBep20Candidates } from "./candidate-scan.js";
import { persistCandidateArtifacts } from "./candidate-storage.js";

async function main() {
  const result = await scanBep20Candidates();
  const paths = await persistCandidateArtifacts(result);

  console.log(
    JSON.stringify(
      {
        ok: true,
        count: result.count,
        jsonPath: paths.latestJsonPath,
        csvPath: paths.latestCsvPath,
        historyJsonPath: paths.historyJsonPath,
        historyCsvPath: paths.historyCsvPath
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});