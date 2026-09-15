import { getDb } from "@/lib/db";
import { NextResponse } from "next/server";
import sql from "mssql";

export interface OutboundRow {
    SKU: string;
    /** 창고코드(WRHS_NM) → 최근 7일 단순평균 출고량 */
    recentWeek: Record<string, number>;
    /**
     * 창고코드(WRHS_NM) → 발주선적엔진(default_manual) 기준 일판매량의 "기본값".
     * newProductDaily = 0.7×(최근7일 중위값) + 0.2×(최근28일 중위값) + 0.1×(최근56일 중위값).
     * 실제 사용 시엔 판정 시점까지 남은 일수에 맞는 추세배수(engineTrendRatios)를 곱해야 한다.
     */
    engineBaseDaily: Record<string, number>;
    /**
     * 창고코드(WRHS_NM) → 작년 오늘 기준 -30~+150일을 30일씩 6구간(w0~w5)으로 나눈 판매 중위값의
     * 인접 구간 비율 5개(추세1~5) = [w1/w0, w2/w1, w3/w2, w4/w3, w5/w4].
     */
    engineTrendRatios: Record<string, [number, number, number, number, number]>;
}

type DailyQtyRow = {
    SKU: string;
    WRHS_NM: string;
    ORD_DATE: Date;
    QTY: number;
};

// 최근 56일(engineBaseDaily) + 작년 -30~+150일 추세 구간(최대 395일 전)까지 한 번에 가져온다.
const LOOKBACK_DAYS = 395;

const DAILY_QTY_QUERY = `
    SELECT
        pg.INVT_SKU AS SKU,
        o.WAREHOUSE AS WRHS_NM,
        CAST(o.ORD_DE AS DATE) AS ORD_DATE,
        SUM(o.QTY) AS QTY
    FROM [HGBC].[SD].[TB_ORD_DAIL] o
    JOIN [HGBC].[SD].[TB_PROD_GROUP] pg ON o.ITM_ID = pg.ITM_ID
    WHERE o.ORD_DE >= @cutoffDate
      AND pg.INVT_SKU <> ''
    GROUP BY pg.INVT_SKU, o.WAREHOUSE, CAST(o.ORD_DE AS DATE)
`;

/** 오늘(PST) 기준 daysAgo일 전 00:00:00(PST) 문자열을 반환한다. */
function getPstCutoffDate(daysAgo: number): string {
    const pstNow = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
    pstNow.setDate(pstNow.getDate() - daysAgo);
    const y = pstNow.getFullYear();
    const m = String(pstNow.getMonth() + 1).padStart(2, "0");
    const d = String(pstNow.getDate()).padStart(2, "0");
    return `${y}-${m}-${d} 00:00:00`;
}

/** 오늘(PST) 기준 daysAgo일 전 날짜만(YYYY-MM-DD). */
function getPstDateOnly(daysAgo: number): string {
    const pstNow = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
    pstNow.setDate(pstNow.getDate() - daysAgo);
    const y = pstNow.getFullYear();
    const m = String(pstNow.getMonth() + 1).padStart(2, "0");
    const d = String(pstNow.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
}

/** startDaysAgo(더 과거)부터 endDaysAgoExclusive일 전까지(제외) 날짜 목록. 예: pstDateRange(6, -1) = 오늘 포함 최근 7일. */
function pstDateRange(startDaysAgo: number, endDaysAgoExclusive: number): string[] {
    const dates: string[] = [];
    for (let d = startDaysAgo; d > endDaysAgoExclusive; d--) dates.push(getPstDateOnly(d));
    return dates;
}

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** 발주선적엔진과 동일한 가중치로 낸 신제품(=default_manual 모드 전체 적용) 기준 일판매량. */
function newProductDaily(cy7: number, cy28: number, cy56: number): number {
    return 0.7 * cy7 + 0.2 * cy28 + 0.1 * cy56;
}

function safeMedianRatio(numer: number, denom: number): number {
    return denom > 0 ? numer / denom : 1;
}

// 발주선적엔진과 동일한 6구간 경계(작년 오늘 기준 -30~+150일, 30일 단위).
const TREND_WINDOW_BOUNDS: { startDaysAgo: number; endDaysAgo: number }[] = [
    { startDaysAgo: 395, endDaysAgo: 365 }, // w0
    { startDaysAgo: 365, endDaysAgo: 335 }, // w1
    { startDaysAgo: 335, endDaysAgo: 305 }, // w2
    { startDaysAgo: 305, endDaysAgo: 275 }, // w3
    { startDaysAgo: 275, endDaysAgo: 245 }, // w4
    { startDaysAgo: 245, endDaysAgo: 215 }, // w5
];

export async function GET() {
    try {
        const db = await getDb();
        const result = await db
            .request()
            .input("cutoffDate", sql.VarChar, getPstCutoffDate(LOOKBACK_DAYS))
            .query<DailyQtyRow>(DAILY_QTY_QUERY);

        // SKU -> WRHS_NM -> "YYYY-MM-DD" -> qty
        const bySkuWh = new Map<string, Map<string, Map<string, number>>>();
        for (const row of result.recordset) {
            const dateStr = row.ORD_DATE.toISOString().slice(0, 10);
            if (!bySkuWh.has(row.SKU)) bySkuWh.set(row.SKU, new Map());
            const byWh = bySkuWh.get(row.SKU)!;
            if (!byWh.has(row.WRHS_NM)) byWh.set(row.WRHS_NM, new Map());
            byWh.get(row.WRHS_NM)!.set(dateStr, row.QTY);
        }

        const cy7Dates = pstDateRange(6, -1);
        const cy28Dates = pstDateRange(27, -1);
        const cy56Dates = pstDateRange(55, -1);
        const trendWindowDates = TREND_WINDOW_BOUNDS.map((w) => pstDateRange(w.startDaysAgo, w.endDaysAgo));

        const data: OutboundRow[] = [];
        for (const [sku, byWh] of bySkuWh) {
            const recentWeek: Record<string, number> = {};
            const engineBaseDaily: Record<string, number> = {};
            const engineTrendRatios: Record<string, [number, number, number, number, number]> = {};

            for (const [wh, byDate] of byWh) {
                const sumOf = (dates: string[]) => dates.reduce((acc, d) => acc + (byDate.get(d) ?? 0), 0);
                const medianOf = (dates: string[]) => median(dates.map((d) => byDate.get(d) ?? 0));

                recentWeek[wh] = sumOf(cy7Dates) / 7;

                const cy7 = medianOf(cy7Dates);
                const cy28 = medianOf(cy28Dates);
                const cy56 = medianOf(cy56Dates);
                engineBaseDaily[wh] = newProductDaily(cy7, cy28, cy56);

                const [w0, w1, w2, w3, w4, w5] = trendWindowDates.map(medianOf);
                engineTrendRatios[wh] = [
                    safeMedianRatio(w1, w0),
                    safeMedianRatio(w2, w1),
                    safeMedianRatio(w3, w2),
                    safeMedianRatio(w4, w3),
                    safeMedianRatio(w5, w4),
                ];
            }

            data.push({ SKU: sku, recentWeek, engineBaseDaily, engineTrendRatios });
        }

        return NextResponse.json({
            success: true,
            data,
        });
    } catch (err) {
        console.error("출고량 조회 오류:", err);
        return NextResponse.json(
            { success: false, error: String(err) },
            { status: 500 }
        );
    }
}
