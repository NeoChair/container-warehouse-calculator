import { getDb } from "@/lib/db";
import { NextResponse } from "next/server";

export interface ContainerRow {
    OWNR_ETP_CD: string;
    PO_NO: string;
    ITM_ID: string;
    GATH_DE: string;
    /** 아직 실제 컨테이너에 안 실린 생산계획 단계 PO는 빈 문자열. */
    CONT_NO: string;
    SUPL_FACT: string;
    WRHS_NM: string;
    QTY: number;
    ETA: string | null;
    ETD: string | null;
}

// 실제 컨테이너에 실려 입항 예정인 물량. 창고 필터는 프론트에서 처리.
const INTRANSIT_QUERY = `
    SELECT
        [OWNR_ETP_CD], [PO_NO], [ITM_ID], [GATH_DE], [CONT_NO], [SUPL_FACT], [WRHS_NM], [QTY], [ETA], [ETD]
    FROM [HGBC].[RPA].[TB_INTRANSIT_STOCK_DAIL]
    WHERE GATH_DE = (SELECT MAX(GATH_DE) FROM [HGBC].[RPA].[TB_INTRANSIT_STOCK_DAIL])
`;

// 아직 실제 컨테이너에 안 실린 생산계획(선적계획) 단계 PO. CONT_NO 컬럼 자체가 없어서 병합 시 빈 문자열로 채운다.
// 창고 컬럼명이 WRHS_CD라 TB_INTRANSIT_STOCK_DAIL과 같은 이름(WRHS_NM)으로 별칭을 준다.
type PlanRow = {
    OWNR_ETP_CD: string;
    PO_NO: string;
    ITM_ID: string;
    GATH_DE: string;
    SUPL_FACT: string;
    WRHS_NM: string;
    QTY: number;
    ETD: string | null;
    ETA: string | null;
};

const PLAN_QUERY = `
    SELECT
        [OWNR_ETP_CD], [PO_NO], [ITM_ID], [GATH_DE], [SUPL_FACT], [WRHS_CD] AS WRHS_NM, [QTY], [ETD], [ETA]
    FROM [HGBC].[RPA].[TB_SHIPPING_PLAN_STOCK]
    WHERE GATH_DE = (SELECT MAX(GATH_DE) FROM [HGBC].[RPA].[TB_SHIPPING_PLAN_STOCK])
`;

// TB_SHIPPING_PLAN_STOCK의 ETA/ETD는 "2026-09-27"처럼 구분자가 있는 형식이라, TB_INTRANSIT_STOCK_DAIL의
// 구분자 없는 "20260927" 형식(프론트 파서가 기대하는 형식)에 맞춰 하이픈만 제거한다.
function toCompactDate(s: string | null): string | null {
    if (!s) return null;
    return s.replace(/-/g, "");
}

export async function GET() {
    try {
        const db = await getDb();
        const [intransitResult, planResult] = await Promise.all([
            db.request().query<ContainerRow>(INTRANSIT_QUERY),
            db.request().query<PlanRow>(PLAN_QUERY),
        ]);

        const planRows: ContainerRow[] = planResult.recordset.map((r) => ({
            OWNR_ETP_CD: r.OWNR_ETP_CD,
            PO_NO: r.PO_NO,
            ITM_ID: r.ITM_ID,
            GATH_DE: r.GATH_DE,
            CONT_NO: "",
            SUPL_FACT: r.SUPL_FACT,
            WRHS_NM: r.WRHS_NM,
            QTY: r.QTY,
            ETA: toCompactDate(r.ETA),
            ETD: toCompactDate(r.ETD),
        }));

        return NextResponse.json({
            success: true,
            data: [...intransitResult.recordset, ...planRows],
        });
    } catch (err) {
        console.error("컨테이너 조회 오류:", err);
        return NextResponse.json(
            { success: false, error: String(err) },
            { status: 500 }
        );
    }
}
