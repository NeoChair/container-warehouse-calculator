import { getDb } from "@/lib/db";
import { getSharedGathDe } from "@/lib/gathDe";
import { NextResponse } from "next/server";
import sql from "mssql";

type SummaryRow = {
    SKU: string;
    CA_STOCK: number | null;
    CA2_STOCK: number | null;
    GA_STOCK: number | null;
    GA2_STOCK: number | null;
    NJ_STOCK: number | null;
    TX_STOCK: number | null;
};

const SUMMARY_QUERY = `
    SELECT [SKU], [CA_STOCK], [CA2_STOCK], [GA_STOCK], [GA2_STOCK], [NJ_STOCK], [TX_STOCK]
    FROM [HGBC].[RPA].[TB_SALES_STOCK_SUMMARY]
    WHERE GATH_DE = @gathDe
`;

export async function GET() {
    try {
        const db = await getDb();
        const gathDe = await getSharedGathDe();
        const result = await db.request().input("gathDe", sql.VarChar, gathDe).query<SummaryRow>(SUMMARY_QUERY);

        // 요약 스냅샷은 창고를 주(state) 약어로 저장한다. 컨테이너/출고 API와 같은 창고 숫자코드(WID)로 맞춰준다.
        const data = result.recordset.map((row) => ({
            SKU: row.SKU,
            stocks: {
                "14630": row.CA_STOCK ?? 0, // Paramount
                "14631": row.CA2_STOCK ?? 0, // Vernon
                "14632": row.GA_STOCK ?? 0, // Atlanta
                "14633": row.GA2_STOCK ?? 0, // Pendergrass
                "14634": row.NJ_STOCK ?? 0, // New Jersey
                "14636": row.TX_STOCK ?? 0, // Houston
            },
        }));

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
