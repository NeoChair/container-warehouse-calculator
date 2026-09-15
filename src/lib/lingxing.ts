import crypto from "crypto";

const APP_KEY = process.env.LINGXING_APP_KEY!;
const APP_SECRET = process.env.LINGXING_APP_SECRET!;

const TOKEN_ENDPOINT = "https://openapi.lingxing.com/api/auth-server/oauth/access-token";
const INVENTORY_ENDPOINT = "https://openapi.lingxing.com/erp/sc/routing/data/local_inventory/inventoryDetails";

// 창고 하나만 대상으로 필터링하지 않고 전체를 받아온다 (온타리오/뉴저지 등 프로젝트별로 재사용).
const WID_FILTER = "14630,14631,14632,14633,14634,14635,14636";
const PAGE_SIZE = 300;
// LingXing API 레이트리밋 대응. RPA 워크플로우와 동일하게 페이지마다 5초 대기.
const PAGE_DELAY_MS = 5000;
const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 10000;
// 전체 창고 재고를 매번 새로 긁는 건 느리고 레이트리밋에 걸리기 쉬워서 짧게 캐시한다.
const CACHE_TTL_MS = 2 * 60 * 1000;

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
    if (cachedToken && cachedToken.expiresAt > Date.now()) {
        return cachedToken.token;
    }

    const url = `${TOKEN_ENDPOINT}?appId=${encodeURIComponent(APP_KEY)}&appSecret=${encodeURIComponent(APP_SECRET)}`;
    const res = await fetch(url, { method: "POST" });
    const json = await res.json();
    const token = json?.data?.access_token;

    if (!token) {
        throw new Error(`LingXing 토큰 발급 실패: ${JSON.stringify(json)}`);
    }

    const expiresIn = Number(json?.data?.expires_in ?? 7200);
    cachedToken = { token, expiresAt: Date.now() + (expiresIn - 60) * 1000 };
    return token;
}

// signString = access_token/app_key/length/offset/timestamp/wid 조합 → MD5 → AES-128-ECB(appKey) → Base64 → URL 인코딩
function buildSign(accessToken: string, offset: number, timestamp: number): string {
    const signString =
        `access_token=${accessToken}&app_key=${APP_KEY}&length=${PAGE_SIZE}` +
        `&offset=${offset}&timestamp=${timestamp}&wid=${WID_FILTER}`;

    const md5Hash = crypto.createHash("md5").update(signString, "utf8").digest("hex").toUpperCase();

    const cipher = crypto.createCipheriv("aes-128-ecb", Buffer.from(APP_KEY, "utf8"), null);
    const encrypted = Buffer.concat([cipher.update(md5Hash, "utf8"), cipher.final()]);

    return encodeURIComponent(encrypted.toString("base64"));
}

interface LingxingInventoryItem {
    sku?: string;
    wid?: string | number;
    third_inventory?: { qty_sellable?: number };
}

interface LingxingInventoryResponse {
    code: number;
    total?: number;
    data?: LingxingInventoryItem[];
    error_details?: unknown[];
}

export interface LingxingInventoryRow {
    SKU: string;
    /** 창고코드(WRHS_NM, 예: "14630") → 재고수량 */
    stocks: Record<string, number>;
}

async function fetchPage(accessToken: string, offset: number): Promise<LingxingInventoryResponse> {
    for (let attempt = 0; ; attempt++) {
        const timestamp = Math.floor(Date.now() / 1000);
        const sign = buildSign(accessToken, offset, timestamp);
        const url =
            `${INVENTORY_ENDPOINT}?access_token=${encodeURIComponent(accessToken)}` +
            `&app_key=${encodeURIComponent(APP_KEY)}&sign=${sign}&timestamp=${timestamp}`;

        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ length: PAGE_SIZE, offset, timestamp, wid: WID_FILTER }),
        });
        const json: LingxingInventoryResponse = await res.json();

        if (json.code === 0) return json;
        if (attempt >= MAX_RETRIES) {
            throw new Error(`LingXing 재고 조회 실패 (offset=${offset}): ${JSON.stringify(json)}`);
        }
        // 레이트리밋(과도한 요청) 등 일시적 오류로 보고 대기 후 재시도.
        await sleep(RETRY_DELAY_MS);
    }
}

async function fetchLingxingInventoryUncached(): Promise<LingxingInventoryRow[]> {
    const accessToken = await getAccessToken();
    const stockBySku = new Map<string, Record<string, number>>();

    let offset = 0;
    let total = 0;
    let isFirstPage = true;

    do {
        await sleep(PAGE_DELAY_MS);

        const json = await fetchPage(accessToken, offset);

        if (isFirstPage) {
            total = Number(json.total ?? 0);
            isFirstPage = false;
        }

        for (const item of json.data ?? []) {
            const sku = String(item.sku ?? "").trim();
            if (!sku) continue;

            const wid = String(item.wid ?? "");
            const qty = Number(item.third_inventory?.qty_sellable ?? 0);

            if (!stockBySku.has(sku)) {
                stockBySku.set(sku, {});
            }
            const entry = stockBySku.get(sku)!;
            entry[wid] = (entry[wid] ?? 0) + qty;
        }

        offset += PAGE_SIZE;
    } while (offset < total);

    return Array.from(stockBySku.entries()).map(([SKU, stocks]) => ({ SKU, stocks }));
}

let cache: { data: LingxingInventoryRow[]; expiresAt: number } | null = null;
let inFlight: Promise<LingxingInventoryRow[]> | null = null;

export async function fetchLingxingInventory(): Promise<LingxingInventoryRow[]> {
    if (cache && cache.expiresAt > Date.now()) return cache.data;
    if (inFlight) return inFlight;

    inFlight = fetchLingxingInventoryUncached()
        .then((data) => {
            cache = { data, expiresAt: Date.now() + CACHE_TTL_MS };
            return data;
        })
        .finally(() => {
            inFlight = null;
        });

    return inFlight;
}
