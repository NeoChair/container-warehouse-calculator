"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type ContainerApiRow = {
    OWNR_ETP_CD: string;
    PO_NO: string;
    ITM_ID: string; // SKU
    GATH_DE: string;
    CONT_NO: string;
    SUPL_FACT: string;
    WRHS_NM: string;
    QTY: number;
    ETA: string | null;
    ETD: string | null;
};

type InventoryApiRow = {
    SKU: string;
    stocks: Record<string, number>;
};

type OutboundApiRow = {
    SKU: string;
    recentWeek: Record<string, number>;
    engineBaseDaily: Record<string, number>;
    engineTrendRatios: Record<string, [number, number, number, number, number]>;
};

type DailySalesMode = "recentWeek" | "trendBased";

const DAILY_SALES_MODE_OPTIONS: { value: DailySalesMode; label: string }[] = [
    { value: "recentWeek", label: "최근 1주 평균" },
    { value: "trendBased", label: "발주선적엔진 기준" },
];

/**
 * 판정 시점까지 남은 일수(daysAhead)에 맞는 추세배수. 작년 -30~+150일 6구간 인접비율(추세1~5) 중,
 * daysAhead가 속한 30일 구간 인덱스(floor(daysAhead/30))부터 아래로 캐스케이드하며 1 이상(성장)인
 * 첫 값을 쓴다. 못 찾으면(전부 하락) 1(보정 없음).
 */
function shipTrendFor(ratios: [number, number, number, number, number] | undefined, daysAhead: number): number {
    if (!ratios) return 1;
    const startIdx = Math.min(ratios.length - 1, Math.floor(Math.max(0, daysAhead) / 30));
    for (let i = startIdx; i >= 0; i--) {
        if (ratios[i] >= 1) return ratios[i];
    }
    return 1;
}

type GroupedContainer = {
    /** React key/override key로 쓰는 그룹 고유 식별자. 컨테이너 배정 전이면 CONT_NO 대신 PO_NO 기반 합성키. */
    groupKey: string;
    /** 실제 컨테이너 번호. 아직 컨테이너 미배정(생산계획 단계)이면 빈 문자열. */
    contNo: string;
    eta: Date;
    etd: string | null;
    originCode: string;
    items: { sku: string; qty: number; poNo: string; suplFact: string }[];
};

type SkuCalc = {
    sku: string;
    qty: number;
    currentStock: number;
    balanceBeforeArrival: number;
    avgDailyOutbound: number;
    dsiDays: number;
    stockOutDate: Date | null;
    needsBackfill: boolean;
};

type ContainerCalc = {
    container: GroupedContainer;
    arrivalDate: Date;
    autoCode: string;
    finalCode: string;
    items: SkuCalc[];
};

type Option = { value: string; label: string };

const NEW_WH_KEY = "__NEW__";

// 실제 창고 코드는 고정이라 편집 가능한 텍스트 입력 대신 상수 맵으로 표시한다.
const WAREHOUSE_MAP: Record<string, string> = {
    "0": "CastleGate",
    "14630": "Paramount",
    "14631": "Vernon",
    "14632": "Atlanta",
    "14633": "Pendergrass",
    "14634": "New Jersey",
    "14636": "Houston",
};
const WAREHOUSE_CODES = ["0", "14630", "14631", "14632", "14633", "14634", "14636"];
const WAREHOUSE_OPTIONS: Option[] = WAREHOUSE_CODES.map((code) => ({
    value: code,
    label: `${code} · ${WAREHOUSE_MAP[code]}`,
}));

function toDateOnly(d: Date): Date {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d: Date, days: number): Date {
    const r = new Date(d);
    r.setDate(r.getDate() + days);
    return r;
}

function daysBetween(a: Date, b: Date): number {
    return (b.getTime() - a.getTime()) / 86400000;
}

function fmtDate(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
}

// ETA/ETD가 "20261008"처럼 구분자 없는 YYYYMMDD 문자열로 오기 때문에 Date 생성자로는 못 읽는다.
function parseCompactDate(s: string | null): Date | null {
    if (!s) return null;
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function SelectArrowIcon() {
    return (
        <svg
            data-baseweb="icon"
            viewBox="0 0 24 24"
            className="pointer-events-none absolute right-3 top-1/2 h-5 w-5 -translate-y-1/2 fill-gray-500"
        >
            <title>open</title>
            <path
                transform="rotate(270, 12, 12)"
                fillRule="evenodd"
                clipRule="evenodd"
                d="M9 12C9 12.2652 9.10536 12.5196 9.29289 12.7071L13.2929 16.7071C13.6834 17.0976 14.3166 17.0976 14.7071 16.7071C15.0976 16.3166 15.0976 15.6834 14.7071 15.2929L11.4142 12L14.7071 8.70711C15.0976 8.31658 15.0976 7.68342 14.7071 7.29289C14.3166 6.90237 13.6834 6.90237 13.2929 7.29289L9.29289 11.2929C9.10536 11.4804 9 11.7348 9 12Z"
            />
        </svg>
    );
}

function ChevronIcon({ open }: { open: boolean }) {
    return (
        <svg
            viewBox="0 0 24 24"
            aria-hidden="true"
            focusable="false"
            fill="currentColor"
            className={`h-5 w-5 shrink-0 text-gray-400 transition-transform duration-150 ${open ? "rotate-90" : ""}`}
        >
            <path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6-6-6z" />
        </svg>
    );
}

function CustomSelect({
    options,
    value,
    onChange,
}: {
    options: Option[];
    value: string;
    onChange: (value: string) => void;
}) {
    const [open, setOpen] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        function handleClickOutside(e: MouseEvent) {
            if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
                setOpen(false);
            }
        }
        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, []);

    const selected = options.find((o) => o.value === value) ?? options[0];

    return (
        <div className="relative w-full min-w-[200px]" ref={containerRef}>
            <button
                type="button"
                onClick={() => setOpen((prev) => !prev)}
                className={`h-10 w-full rounded-md border border-gray-300 bg-white pl-3 pr-9 text-left text-sm text-gray-800 focus:outline-none focus:ring-1 focus:ring-[#ff4b4b] ${
                    open ? "ring-1 ring-[#ff4b4b]" : ""
                }`}
            >
                {selected?.label}
            </button>
            <SelectArrowIcon />

            {open && (
                <ul
                    role="listbox"
                    className="absolute z-20 mt-1 max-h-60 w-full overflow-auto rounded-md border border-gray-300 bg-white py-1 text-sm shadow-lg"
                >
                    {options.map((option) => (
                        <li
                            key={option.value}
                            role="option"
                            aria-selected={option.value === value}
                            onClick={() => {
                                onChange(option.value);
                                setOpen(false);
                            }}
                            className={`cursor-pointer px-3 py-2 text-gray-800 hover:bg-[#ff4b4b] hover:text-white ${
                                option.value === value ? "bg-[#ff4b4b]/10 font-medium" : ""
                            }`}
                        >
                            {option.label}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

function DeleteIcon() {
    return (
        <svg viewBox="5 5 13.186 13.186" className="h-3.5 w-3.5 fill-current">
            <title>Delete</title>
            <path
                fillRule="evenodd"
                clipRule="evenodd"
                d="M7.29289 7.29289C7.68342 6.90237 8.31658 6.90237 8.70711 7.29289L12 10.5858L15.2929 7.29289C15.6834 6.90237 16.3166 6.90237 16.7071 7.29289C17.0976 7.68342 17.0976 8.31658 16.7071 8.70711L13.4142 12L16.7071 15.2929C17.0976 15.6834 17.0976 16.3166 16.7071 16.7071C16.3166 17.0976 15.6834 17.0976 15.2929 16.7071L12 13.4142L8.70711 16.7071C8.31658 17.0976 7.68342 17.0976 7.29289 16.7071C6.90237 16.3166 6.90237 15.6834 7.29289 15.2929L10.5858 12L7.29289 8.70711C6.90237 8.31658 6.90237 7.68342 7.29289 7.29289Z"
            />
        </svg>
    );
}

function MultiSelect({
    options,
    values,
    onChange,
    placeholder,
}: {
    options: Option[];
    values: string[];
    onChange: (values: string[]) => void;
    placeholder: string;
}) {
    const [open, setOpen] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        function handleClickOutside(e: MouseEvent) {
            if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
                setOpen(false);
            }
        }
        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, []);

    function toggle(value: string) {
        if (values.includes(value)) {
            onChange(values.filter((v) => v !== value));
        } else {
            onChange([...values, value]);
        }
    }

    return (
        <div className="relative w-full min-w-[245px]" ref={containerRef}>
            <div
                onClick={() => setOpen((prev) => !prev)}
                className={`flex min-h-10 w-full cursor-pointer flex-wrap items-center gap-1.5 rounded-md border border-gray-300 bg-white px-2 py-1.5 pr-9 focus-within:ring-1 focus-within:ring-[#ff4b4b] ${
                    open ? "ring-1 ring-[#ff4b4b]" : ""
                }`}
            >
                {values.length === 0 && <span className="px-1 text-sm text-gray-400">{placeholder}</span>}
                {values.map((v) => {
                    const label = options.find((o) => o.value === v)?.label ?? v;
                    return (
                        <span
                            key={v}
                            className="flex items-center gap-1 rounded-md bg-[#ff4b4b]/10 px-2 py-1 text-sm text-[#ff4b4b]"
                        >
                            <span title={label}>{label}</span>
                            <span
                                role="button"
                                tabIndex={0}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    toggle(v);
                                }}
                                className="cursor-pointer hover:text-[#c0392b]"
                            >
                                <DeleteIcon />
                            </span>
                        </span>
                    );
                })}
            </div>
            <SelectArrowIcon />

            {open && (
                <ul
                    role="listbox"
                    className="absolute z-20 mt-1 max-h-60 w-full overflow-auto rounded-md border border-gray-300 bg-white py-1 text-sm shadow-lg"
                >
                    {options.map((option) => {
                        const checked = values.includes(option.value);
                        return (
                            <li
                                key={option.value}
                                role="option"
                                aria-selected={checked}
                                onClick={() => toggle(option.value)}
                                className={`cursor-pointer px-3 py-2 text-gray-800 hover:bg-[#ff4b4b] hover:text-white ${
                                    checked ? "bg-[#ff4b4b]/10 font-medium" : ""
                                }`}
                            >
                                {option.label}
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
}

export default function Home() {
    const [inventory, setInventory] = useState<InventoryApiRow[]>([]);
    const [containers, setContainers] = useState<ContainerApiRow[]>([]);
    const [outbound, setOutbound] = useState<OutboundApiRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const [enabledCodes, setEnabledCodes] = useState<string[]>(["14630", "14631"]);
    const [newWarehouseName, setNewWarehouseName] = useState("Ontario");
    const [openDate, setOpenDate] = useState("2026-11-01");
    const [transitLeadDays, setTransitLeadDays] = useState(7);
    const [refDate, setRefDate] = useState("ALL");
    const [manualOverrides, setManualOverrides] = useState<Record<string, string>>({});
    const [expanded, setExpanded] = useState<Set<string>>(new Set());

    useEffect(() => {
        Promise.all([fetch("/api/inventory"), fetch("/api/containers"), fetch("/api/outbound")])
            .then(async ([invRes, contRes, outRes]) => {
                const invJson = await invRes.json();
                const contJson = await contRes.json();
                const outJson = await outRes.json();
                if (!invJson.success) throw new Error(invJson.error ?? "재고 조회 실패");
                if (!contJson.success) throw new Error(contJson.error ?? "컨테이너 조회 실패");
                if (!outJson.success) throw new Error(outJson.error ?? "출고량 조회 실패");
                setInventory(invJson.data);
                setContainers(contJson.data);
                setOutbound(outJson.data);
            })
            .catch((err) => setError(String(err)))
            .finally(() => setLoading(false));
    }, []);

    const inventoryBySku = useMemo(() => {
        const map = new Map<string, Record<string, number>>();
        for (const row of inventory) map.set(row.SKU, row.stocks);
        return map;
    }, [inventory]);

    const [dailySalesMode, setDailySalesMode] = useState<DailySalesMode>("recentWeek");

    const outboundBySku = useMemo(() => {
        const map = new Map<string, OutboundApiRow>();
        for (const row of outbound) map.set(row.SKU, row);
        return map;
    }, [outbound]);

    // 오늘 날짜를 한 번만 고정해서 그룹핑 필터랑 시뮬레이션 시작점에 동일하게 쓴다.
    const today = useMemo(() => toDateOnly(new Date()), []);

    /**
     * 선택된 계산 방식의 일 예상출고량. "발주선적엔진 기준"은 판정 시점(refDate)까지 남은 일수에 따라
     * 같은 SKU+창고라도 값이 달라진다(추세배수가 판정 시점의 계절 구간을 따라가므로).
     * 데이터가 없는 SKU+창고 조합(최근 출고 이력 없음)은 0으로 취급.
     */
    const getAvgDailyOutbound = (sku: string, whCode: string, refDate: Date) => {
        const entry = outboundBySku.get(sku);
        if (!entry) return 0;
        if (dailySalesMode === "recentWeek") return entry.recentWeek[whCode] ?? 0;
        const baseDaily = entry.engineBaseDaily[whCode] ?? 0;
        const shipTrend = shipTrendFor(entry.engineTrendRatios[whCode], daysBetween(today, refDate));
        return baseDaily * shipTrend;
    };

    const groupedContainers = useMemo(() => {
        const groups = new Map<string, GroupedContainer>();
        for (const row of containers) {
            const eta = parseCompactDate(row.ETA);
            // ETA가 이미 지난 건은 항구 도착 시점에 이미 라우팅이 정해졌을 거라 볼 필요 없음.
            if (!eta || eta < today || !enabledCodes.includes(row.WRHS_NM)) continue;
            // CONT_NO가 빈 값이면 아직 실제 컨테이너에 안 실린 생산계획 단계 품목. 이 경우 서로 무관한
            // 품목들이 빈 CONT_NO 하나로 뭉치지 않도록 PO_NO 기준으로 그룹핑한다.
            const groupKey = row.CONT_NO || `NOCONT::${row.PO_NO}`;
            let g = groups.get(groupKey);
            if (!g) {
                g = { groupKey, contNo: row.CONT_NO, eta, etd: row.ETD, originCode: row.WRHS_NM, items: [] };
                groups.set(groupKey, g);
            }
            g.items.push({ sku: row.ITM_ID, qty: row.QTY, poNo: row.PO_NO, suplFact: row.SUPL_FACT });
        }
        return Array.from(groups.values()).sort((a, b) => a.eta.getTime() - b.eta.getTime());
    }, [containers, enabledCodes, today]);

    const etaDateOptions = useMemo(() => {
        const dates = new Set(groupedContainers.map((g) => fmtDate(g.eta)));
        return Array.from(dates).sort();
    }, [groupedContainers]);

    const openDateObj = openDate ? toDateOnly(new Date(openDate)) : null;

    // 창고 필터가 바뀌어서 선택된 ETA 날짜가 목록에서 사라질 수 있다. 그 상태로 그냥 두면
    // 드롭다운은 "전체"로 보이는데 실제로는 존재하지 않는 날짜로 필터링되어 목록이 비어버린다.
    const effectiveRefDate = refDate !== "ALL" && !etaDateOptions.includes(refDate) ? "ALL" : refDate;

    const containerCalcs: ContainerCalc[] = useMemo(() => {
        const balances = new Map<string, number>();
        const lastDecayDate = new Map<string, Date>();
        const simStart = today;

        const keyOf = (sku: string, whCode: string) => `${sku}::${whCode}`;
        const initKey = (sku: string, whCode: string) => {
            const key = keyOf(sku, whCode);
            if (!balances.has(key)) {
                const starting = whCode === NEW_WH_KEY ? 0 : inventoryBySku.get(sku)?.[whCode] ?? 0;
                balances.set(key, starting);
                lastDecayDate.set(key, simStart);
            }
            return key;
        };
        const decayTo = (sku: string, whCode: string, date: Date) => {
            const key = initKey(sku, whCode);
            const last = lastDecayDate.get(key)!;
            const elapsed = Math.max(0, daysBetween(last, date));
            const rate = getAvgDailyOutbound(sku, whCode, date);
            balances.set(key, balances.get(key)! - rate * elapsed);
            lastDecayDate.set(key, date);
            return balances.get(key)!;
        };

        const results: ContainerCalc[] = [];

        for (const container of groupedContainers) {
            const arrivalDate = addDays(container.eta, transitLeadDays);
            const itemCalcs: SkuCalc[] = container.items.map(({ sku, qty }) => {
                const currentStock = inventoryBySku.get(sku)?.[container.originCode] ?? 0;
                const balanceBeforeArrival = decayTo(sku, container.originCode, container.eta);
                const rate = getAvgDailyOutbound(sku, container.originCode, container.eta);
                // 최근 7일 출고 이력이 없는 SKU(rate=0)는 이 재고로 소진되는 일이 없으니 재고소진일도 없고 보충도 불필요.
                const dsiDays = rate > 0 ? balanceBeforeArrival / rate : Infinity;
                const stockOutDate = rate > 0 ? addDays(container.eta, Math.max(0, Math.floor(dsiDays))) : null;
                const needsBackfill = stockOutDate ? (openDateObj ? stockOutDate < openDateObj : true) : false;
                return { sku, qty, currentStock, balanceBeforeArrival, avgDailyOutbound: rate, dsiDays, stockOutDate, needsBackfill };
            });

            const autoCode = itemCalcs.some((i) => i.needsBackfill) ? container.originCode : NEW_WH_KEY;
            const finalCode = manualOverrides[container.groupKey] ?? autoCode;

            for (const { sku, qty } of container.items) {
                initKey(sku, finalCode);
                const key = keyOf(sku, finalCode);
                balances.set(key, balances.get(key)! + qty);
                lastDecayDate.set(key, arrivalDate);
            }

            results.push({ container, arrivalDate, autoCode, finalCode, items: itemCalcs });
        }

        return results;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [groupedContainers, inventoryBySku, outboundBySku, dailySalesMode, openDate, transitLeadDays, manualOverrides, today]);

    const visibleCalcs =
        effectiveRefDate === "ALL" ? containerCalcs : containerCalcs.filter((c) => fmtDate(c.container.eta) === effectiveRefDate);

    const whLabel = (code: string) => (code === NEW_WH_KEY ? newWarehouseName : WAREHOUSE_MAP[code] ?? code);

    const toggleExpanded = (contNo: string) => {
        setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(contNo)) next.delete(contNo);
            else next.add(contNo);
            return next;
        });
    };

    const refDateOptions: Option[] = [
        { value: "ALL", label: "전체" },
        ...etaDateOptions.map((d) => ({ value: d, label: d })),
    ];
    const overrideOptions: Option[] = [
        // { value: "AUTO", label: "자동 판정 따름" },
        ...enabledCodes.map((c) => ({ value: c, label: whLabel(c) })),
        { value: NEW_WH_KEY, label: newWarehouseName },
    ];

    return (
        <div className="min-h-screen bg-[#f0f2f6]">
            <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-10">
                <h1 className="text-2xl font-bold text-gray-800">창고-컨테이너 계산기</h1>

                {error && (
                    <div className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
                )}
                {loading && <div className="text-sm text-gray-500">불러오는 중...</div>}

                <section className="flex flex-col gap-3 rounded-md bg-white p-5 shadow-sm">
                    <h2 className="text-lg font-bold text-gray-700">일 예상판매량 계산 방식</h2>
                    <div className="flex flex-wrap gap-2">
                        {DAILY_SALES_MODE_OPTIONS.map((opt) => (
                            <button
                                key={opt.value}
                                type="button"
                                onClick={() => setDailySalesMode(opt.value)}
                                className={`rounded-md border px-3 py-2 text-left text-sm transition-colors ${
                                    dailySalesMode === opt.value
                                        ? "border-[#ff4b4b] bg-[#ff4b4b]/10 text-[#ff4b4b]"
                                        : "border-gray-300 bg-white text-gray-600 hover:border-gray-400"
                                }`}
                            >
                                {opt.label}
                            </button>
                        ))}
                    </div>
                </section>

                <section className="flex flex-col gap-4 rounded-md bg-white p-5 shadow-sm">
                    <h2 className="text-lg font-bold text-gray-700">기준 창고 설정</h2>

                    <div className="flex flex-col gap-1">
                        <label className="text-sm font-medium text-gray-700">기준 창고 선택</label>
                        <MultiSelect
                            options={WAREHOUSE_OPTIONS}
                            values={enabledCodes}
                            onChange={setEnabledCodes}
                            placeholder="창고 선택..."
                        />
                    </div>

                    <hr className="border-gray-200" />

                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                        <div className="flex flex-col gap-1">
                            <label className="text-sm font-medium text-gray-700">신규(이전 대상) 창고</label>
                            <input
                                type="text"
                                value={newWarehouseName}
                                onChange={(e) => setNewWarehouseName(e.target.value)}
                                className="h-10 rounded-md border border-gray-300 bg-white px-3 text-sm text-gray-800 focus:outline-none focus:ring-1 focus:ring-[#ff4b4b]"
                            />
                        </div>
                        <div className="flex flex-col gap-1">
                            <label className="text-sm font-medium text-gray-700">신규 창고 오픈일</label>
                            <input
                                type="date"
                                value={openDate}
                                onChange={(e) => setOpenDate(e.target.value)}
                                className="h-10 rounded-md border border-gray-300 bg-white px-3 text-sm text-gray-800 focus:outline-none focus:ring-1 focus:ring-[#ff4b4b]"
                            />
                        </div>
                        {/* <div className="flex flex-col gap-1">
                            <label className="text-sm font-medium text-gray-700">🚚 항 도착 → 창고 도착(일)</label>
                            <input
                                type="number"
                                min={0}
                                value={transitLeadDays}
                                onChange={(e) => setTransitLeadDays(Number(e.target.value))}
                                className="h-10 rounded-md border border-gray-300 bg-white px-3 text-sm text-gray-800 focus:outline-none focus:ring-1 focus:ring-[#ff4b4b]"
                            />
                        </div> */}
                    </div>
                    {!openDateObj && (
                        <p className="text-sm text-amber-600">오픈일을 설정하지 않으면 모든 컨테이너가 보충 필요로 판정돼요.</p>
                    )}
                </section>

                <section className="flex items-center gap-3">
                    <label className="text-sm font-medium text-gray-700">ETA</label>
                    <CustomSelect options={refDateOptions} value={effectiveRefDate} onChange={setRefDate} />
                </section>

                <section className="flex flex-col gap-3">
                    {visibleCalcs.map((calc) => {
                        const isOpen = expanded.has(calc.container.groupKey);
                        const isManual = manualOverrides[calc.container.groupKey] !== undefined;
                        const overrideValue = manualOverrides[calc.container.groupKey] ?? "AUTO";
                        const poNos = Array.from(new Set(calc.container.items.map((i) => i.poNo).filter(Boolean)));

                        return (
                            <div key={calc.container.groupKey} className="rounded-md bg-white shadow-sm">
                                <button
                                    type="button"
                                    onClick={() => toggleExpanded(calc.container.groupKey)}
                                    className="flex w-full flex-wrap items-center gap-3 px-5 py-4 text-left"
                                >
                                    <ChevronIcon open={isOpen} />
                                    <span
                                        className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                                            calc.container.contNo
                                                ? "bg-blue-50 text-blue-600"
                                                : "bg-amber-50 text-amber-600"
                                        }`}
                                    >
                                        {calc.container.contNo ? "이동중" : "선적계획"}
                                    </span>
                                    <span className="font-mono text-sm font-medium text-gray-800">
                                        {calc.container.contNo || "—"}
                                    </span>
                                    {poNos.length > 0 && (
                                        <span className="font-mono text-xs text-gray-400" title={poNos.join(", ")}>
                                            {poNos.join(", ")}
                                        </span>
                                    )}
                                    <span className="text-xs text-gray-500">
                                        ETA {fmtDate(calc.container.eta)} → 창고도착 {fmtDate(calc.arrivalDate)}
                                    </span>
                                    <span className="text-xs text-gray-400">원배정 {whLabel(calc.container.originCode)}</span>
                                    <span
                                        className={`rounded-full border px-2 py-0.5 text-xs ${
                                            isManual ? "border-[#ff4b4b] text-[#ff4b4b]" : "border-dashed border-gray-400 text-gray-500"
                                        }`}
                                    >
                                        {whLabel(calc.finalCode)} {isManual ? "· 수동" : "· 자동"}
                                    </span>
                                    <span className="ml-auto text-xs text-gray-400">SKU {calc.items.length}건</span>
                                </button>

                                {isOpen && (
                                    <div className="flex flex-col gap-3 border-t border-gray-100 px-5 py-4">
                                        <div className="flex flex-wrap items-center gap-3">
                                            <span className="text-sm text-gray-600">판정 창고 변경</span>
                                            <CustomSelect
                                                options={overrideOptions}
                                                value={overrideValue}
                                                onChange={(v) =>
                                                    setManualOverrides((prev) => {
                                                        const next = { ...prev };
                                                        if (v === "AUTO") delete next[calc.container.groupKey];
                                                        else next[calc.container.groupKey] = v;
                                                        return next;
                                                    })
                                                }
                                            />
                                            {isManual && calc.autoCode !== calc.finalCode && (
                                                <span className="text-xs text-gray-400">자동판정: {whLabel(calc.autoCode)}</span>
                                            )}
                                        </div>

                                        <div className="overflow-x-auto">
                                            <table className="w-full text-xs">
                                                <thead>
                                                    <tr className="border-b border-gray-200 text-left text-gray-500">
                                                        <th className="py-2 pr-3">SKU</th>
                                                        <th className="py-2 pr-3">수량</th>
                                                        <th className="py-2 pr-3">현재고</th>
                                                        <th className="py-2 pr-3">판정시점 재고</th>
                                                        <th className="py-2 pr-3">일평균출고량</th>
                                                        <th className="py-2 pr-3">재고소진일</th>
                                                        <th className="py-2 pr-3">보충 필요</th>
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {calc.items.map((item) => (
                                                        <tr key={item.sku} className="border-b border-gray-50 last:border-0">
                                                            <td className="py-2 pr-3 font-mono">{item.sku}</td>
                                                            <td className="py-2 pr-3">{item.qty.toLocaleString()}</td>
                                                            <td className="py-2 pr-3">{item.currentStock.toLocaleString()}</td>
                                                            <td className="py-2 pr-3">{Math.round(item.balanceBeforeArrival).toLocaleString()}</td>
                                                            <td className="py-2 pr-3">
                                                                {Math.round(item.avgDailyOutbound * 10) / 10}{" "}
                                                                {/* <span className="text-gray-400">
                                                                    ({DAILY_SALES_MODE_OPTIONS.find((o) => o.value === dailySalesMode)?.label})
                                                                </span> */}
                                                            </td>
                                                            <td className="py-2 pr-3">
                                                                {item.stockOutDate ? fmtDate(item.stockOutDate) : <span className="text-gray-400">판매이력 없음</span>}
                                                            </td>
                                                            <td className="py-2 pr-3">
                                                                {item.needsBackfill ? (
                                                                    <span className="font-medium text-[#ff4b4b]">필요</span>
                                                                ) : (
                                                                    <span className="text-gray-400">여유</span>
                                                                )}
                                                            </td>
                                                        </tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                        </div>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                    {!loading && visibleCalcs.length === 0 && (
                        <p className="text-sm text-gray-400">표시할 컨테이너가 없어요. 기준 창고 설정을 확인해보세요.</p>
                    )}
                </section>
            </main>
        </div>
    );
}
