import { getDb } from "@/lib/db";
import { getSharedGathDe } from "@/lib/gathDe";
import { NextResponse } from "next/server";
import sql from "mssql";

type BackupRow = {
    SKU: string;
    WH_CD: string;
    STOCK: number | null;
};

// 컨테이너/출고 API와 같은 창고 숫자코드(WID). BACKUP 테이블의 WH_CD도 같은 코드라 그대로 쓴다.
const INVENTORY_WAREHOUSES = [
    "14630", // Paramount
    "14631", // Vernon
    "14632", // Atlanta
    "14633", // Pendergrass
    "14634", // New Jersey
    "14636", // Houston
];

const INVENTORY_QUERY = `
    SELECT [SKU], [WH_CD], [STOCK]
    FROM [HGBC].[RPA].[TB_SALES_STOCK_SUMMARY_BACKUP]
    WHERE GATH_DE = @gathDe
      AND WH_CD IN (${INVENTORY_WAREHOUSES.map((c) => `'${c}'`).join(", ")})
`;

export async function GET() {
    try {
        const db = await getDb();
        const gathDe = await getSharedGathDe();
        const result = await db.request().input("gathDe", sql.VarChar, gathDe).query<BackupRow>(INVENTORY_QUERY);

        const stocksBySku = new Map<string, Record<string, number>>();
        for (const row of result.recordset) {
            if (!stocksBySku.has(row.SKU)) {
                stocksBySku.set(row.SKU, Object.fromEntries(INVENTORY_WAREHOUSES.map((c) => [c, 0])));
            }
            stocksBySku.get(row.SKU)![row.WH_CD] = row.STOCK ?? 0;
        }

        const data = [...stocksBySku].map(([SKU, stocks]) => ({ SKU, stocks }));

        return NextResponse.json({
            success: true,
            data,
        });
    } catch (err) {
        console.error("현재 재고 조회 오류 (요약 스냅샷):", err);
        return NextResponse.json(
            { success: false, error: String(err) },
            { status: 500 }
        );
    }
}
