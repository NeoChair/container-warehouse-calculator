import { getDb } from "@/lib/db";

// 이동중/선적계획/요약 세 스냅샷 테이블은 각자 독립적으로 적재되기 때문에, 테이블별로 MAX(GATH_DE)를
// 따로 구하면 서로 다른 날짜가 섞일 수 있다. 세 테이블 모두에 존재하는(=각 테이블 최신값 중 가장 오래된)
// 날짜 하나로 통일해서 세 데이터가 항상 같은 시점 기준으로 맞춰지도록 한다.
const SHARED_GATH_DE_QUERY = `
    SELECT MIN(mx) AS gathDe
    FROM (
        SELECT MAX(GATH_DE) AS mx FROM [HGBC].[RPA].[TB_INTRANSIT_STOCK_DAIL]
        UNION ALL
        SELECT MAX(GATH_DE) FROM [HGBC].[RPA].[TB_SHIPPING_PLAN_STOCK]
        UNION ALL
        SELECT MAX(GATH_DE) FROM [HGBC].[RPA].[TB_SALES_STOCK_SUMMARY]
    ) x
`;

export async function getSharedGathDe(): Promise<string> {
    const db = await getDb();
    const result = await db.request().query<{ gathDe: string | null }>(SHARED_GATH_DE_QUERY);
    const gathDe = result.recordset[0]?.gathDe;
    if (!gathDe) {
        throw new Error("공통 GATH_DE 조회 실패: 이동중/선적계획/요약 스냅샷 테이블 중 하나가 비어 있음");
    }
    return gathDe;
}
