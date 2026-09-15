import { fetchLingxingInventory } from "@/lib/lingxing";
import { NextResponse } from "next/server";

export async function GET() {
    try {
        const data = await fetchLingxingInventory();

        return NextResponse.json({
            success: true,
            data,
        });
    } catch (err) {
        console.error("현재 재고 조회 오류 (LingXing):", err);
        return NextResponse.json(
            { success: false, error: String(err) },
            { status: 500 }
        );
    }
}
