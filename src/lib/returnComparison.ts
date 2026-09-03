/** 同期報酬差：資產累積報酬率減去基準指數累積報酬率。 */
export function calculateReturnGap(
    assetReturn: number | null | undefined,
    benchmarkReturn: number | null | undefined,
): number | null {
    if (!Number.isFinite(assetReturn) || !Number.isFinite(benchmarkReturn)) return null
    return Math.round(((assetReturn as number) - (benchmarkReturn as number)) * 100) / 100
}
