"use client";

import { useMemo } from "react";
import { Area, AreaChart, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ArrowRight } from "@phosphor-icons/react";
import { CHART } from "@/lib/chart";
import { Badge } from "@/components/ui/Badge";
import { relativeTime } from "@/lib/format";
import { learningCurve, type CurveInput, type CurvePoint, type PhaseStats } from "@/lib/learning-curve";

// "Kurva belajar": three stacked charts sharing one x-axis (closes in order) and one hover,
// split by a dashed line at the first close the AI reviewed — left = before it learned.

const WINDOW = 10;
const usd = (n: number) => `${n >= 0 ? "+" : "−"}$${Math.abs(n).toFixed(2)}`;
const pctTxt = (n: number) => `${Math.round(n)}%`;

function Verdict({ before, after, higherIsBetter = true }: { before: number; after: number; higherIsBetter?: boolean }) {
  const diff = after - before;
  if (Math.abs(diff) < 1e-9) return <Badge>sama</Badge>;
  const better = higherIsBetter ? diff > 0 : diff < 0;
  return <Badge tone={better ? "profit" : "loss"}>{better ? "membaik" : "memburuk"}</Badge>;
}

function CompareRow({
  label,
  hint,
  before,
  after,
  fmt,
}: {
  label: string;
  hint: string;
  before: number;
  after: number;
  fmt: (n: number) => string;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-[var(--radius-md)] bg-surface-2 p-3">
      <div className="text-[12px] font-medium text-text-primary">{label}</div>
      <div className="flex flex-wrap items-center gap-2 font-mono text-[15px] tnum">
        <span className="text-text-tertiary">{fmt(before)}</span>
        <ArrowRight size={13} className="text-text-tertiary" />
        <span className="font-semibold text-text-primary">{fmt(after)}</span>
        <Verdict before={before} after={after} />
      </div>
      <div className="text-[11px] text-text-tertiary">{hint}</div>
    </div>
  );
}

function PointTooltip({
  active,
  payload,
  metric,
}: {
  active?: boolean;
  payload?: Array<{ payload: CurvePoint }>;
  metric: (p: CurvePoint) => React.ReactNode;
}) {
  if (!active || !payload?.length) return null;
  const p = payload[0]!.payload;
  return (
    <div className="max-w-[260px] rounded-[var(--radius-md)] border border-border bg-surface-3 px-3 py-2 text-[12px]" style={{ boxShadow: "var(--shadow-lg)" }}>
      <div className="flex items-center gap-2">
        <span className="text-text-tertiary">#{p.i}</span>
        <span className="font-semibold text-text-primary">{p.coin}</span>
        <span className="font-mono tnum" style={{ color: p.win ? CHART.profit : CHART.loss }}>
          {usd(p.net)}
        </span>
      </div>
      {p.when ? <div className="text-text-tertiary">ditutup {relativeTime(p.when)}</div> : null}
      <div className="mt-1 text-text-secondary">{metric(p)}</div>
      {p.learned ? (
        <div className="mt-1" style={{ color: p.learned === "ULANGI" ? CHART.profit : CHART.loss }}>
          💡 AI menulis aturan {p.learned} dari posisi ini
        </div>
      ) : null}
    </div>
  );
}

function ChartBlock({
  n,
  title,
  summary,
  children,
}: {
  n: number;
  title: string;
  summary: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <h3 className="text-[13px] font-semibold text-text-primary">
          <span className="mr-1.5 text-text-tertiary">{n}.</span>
          {title}
        </h3>
        <span className="text-[12px] text-text-secondary">{summary}</span>
      </div>
      <div className="h-[150px] w-full">{children}</div>
    </div>
  );
}

const AXIS = { fill: CHART.axis, fontSize: 11 };

export function LearningCurve({ performance }: { performance: CurveInput[] }) {
  const curve = useMemo(() => learningCurve(performance, WINDOW), [performance]);
  const { points, startIndex, before, after } = curve;
  if (points.length < 2) return null;

  const last = points[points.length - 1]!;
  const sum = (s: PhaseStats | null) => (s ? s.avgNet * s.n : 0);
  const finalColor = last.cumNet >= 0 ? CHART.profit : CHART.loss;

  // Shared decorations: grey "before" band + dashed "AI mulai belajar" line.
  const phaseMarks = (withLabel: boolean) =>
    startIndex && startIndex > 1
      ? [
          <ReferenceArea key="band" x1={1} x2={startIndex} fill="var(--text-tertiary)" fillOpacity={0.1} ifOverflow="hidden" />,
          <ReferenceLine
            key="start"
            x={startIndex}
            stroke={CHART.accent}
            strokeDasharray="4 3"
            label={withLabel ? { value: "AI mulai belajar →", position: "insideTopLeft", fill: CHART.accent, fontSize: 11 } : undefined}
          />,
        ]
      : [];

  const common = { data: points, syncId: "learning-curve", margin: { top: 6, right: 8, bottom: 0, left: -8 } };
  const xAxis = (show: boolean) => (
    <XAxis dataKey="i" type="number" domain={[1, points.length]} hide={!show} tick={AXIS} axisLine={false} tickLine={false} allowDecimals={false} />
  );

  return (
    <section className="flex flex-col gap-4 rounded-[var(--radius-lg)] border border-border bg-surface-1 p-4">
      <div>
        <h2 className="text-[15px] font-semibold text-text-primary">Kurva belajar AI</h2>
        <p className="mt-0.5 max-w-[80ch] text-[12px] text-text-tertiary">
          Setiap titik = satu posisi yang ditutup, dari yang terlama (kiri) ke terbaru (kanan). Area abu-abu = sebelum AI belajar,
          garis putus-putus = saat AI mulai memeriksa setiap posisi dan menulis aturan. Kalau AI benar-benar belajar, garis di
          kanan harus lebih baik daripada di kiri. Arahkan kursor untuk melihat posisinya.
        </p>
      </div>

      {before && after ? (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <CompareRow label="Seberapa sering untung" hint={`${before.n} posisi sebelum → ${after.n} sesudah`} before={before.winRate} after={after.winRate} fmt={pctTxt} />
          <CompareRow label="Rata-rata saat untung" hint="Besar untung per posisi untung" before={before.avgWin} after={after.avgWin} fmt={usd} />
          <CompareRow label="Rata-rata saat rugi" hint="Besar rugi per posisi rugi — makin kecil makin baik" before={before.avgLoss} after={after.avgLoss} fmt={usd} />
          <CompareRow label="Hasil rata-rata per posisi" hint="Untung & rugi digabung" before={before.avgNet} after={after.avgNet} fmt={usd} />
        </div>
      ) : null}

      <ChartBlock
        n={1}
        title={`Seberapa sering untung? (${WINDOW} posisi terakhir)`}
        summary={
          <>
            sekarang <b className="tnum">{pctTxt(last.winRate)}</b> — di atas garis 50% berarti lebih sering untung daripada rugi
          </>
        }
      >
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart {...common}>
            {xAxis(false)}
            <YAxis domain={[0, 100]} ticks={[0, 50, 100]} tick={AXIS} axisLine={false} tickLine={false} tickFormatter={(v: number) => `${v}%`} width={44} />
            {phaseMarks(true)}
            <ReferenceLine y={50} stroke={CHART.grid} strokeDasharray="2 2" />
            <Tooltip cursor={{ stroke: CHART.axis, strokeDasharray: "2 2" }} content={<PointTooltip metric={(p) => `Untung ${pctTxt(p.winRate)} dari ${Math.min(WINDOW, p.i)} posisi terakhir`} />} />
            <Area type="monotone" dataKey="winRate" stroke={CHART.accent} strokeWidth={2} fill={CHART.accent} fillOpacity={0.12} isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      </ChartBlock>

      <ChartBlock
        n={2}
        title="Total uang bersih dari waktu ke waktu"
        summary={
          <>
            sekarang <b className="font-mono tnum" style={{ color: finalColor }}>{usd(last.cumNet)}</b>
            {before && after ? (
              <>
                {" "}· sebelum belajar {usd(sum(before))}, sesudah {usd(sum(after))}
              </>
            ) : null}
            . Titik merah = posisi rugi, turunan tajam = rugi besar.
          </>
        }
      >
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart {...common}>
            {xAxis(false)}
            <YAxis tick={AXIS} axisLine={false} tickLine={false} tickFormatter={(v: number) => `${v < 0 ? "−" : ""}$${Math.abs(v)}`} width={44} />
            {phaseMarks(false)}
            <ReferenceLine y={0} stroke={CHART.grid} />
            <Tooltip cursor={{ stroke: CHART.axis, strokeDasharray: "2 2" }} content={<PointTooltip metric={(p) => `Total bersih sampai sini: ${usd(p.cumNet)}`} />} />
            <Area
              type="linear"
              dataKey="cumNet"
              stroke={finalColor}
              strokeWidth={2}
              fill={finalColor}
              fillOpacity={0.1}
              isAnimationActive={false}
              dot={(props: { cx?: number; cy?: number; payload?: CurvePoint; index?: number }) => (
                <circle
                  key={props.index}
                  cx={props.cx}
                  cy={props.cy}
                  r={props.payload?.win ? 1.8 : 3}
                  fill={props.payload?.win ? CHART.profit : CHART.loss}
                  stroke="none"
                />
              )}
            />
          </AreaChart>
        </ResponsiveContainer>
      </ChartBlock>

      <ChartBlock
        n={3}
        title="Jumlah aturan yang sudah dipelajari"
        summary={
          <>
            <b className="text-profit tnum">{last.rulesRepeat}</b> aturan untuk diulangi ·{" "}
            <b className="text-loss tnum">{last.rulesAvoid}</b> aturan untuk dihindari
          </>
        }
      >
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart {...common}>
            {xAxis(true)}
            <YAxis tick={AXIS} axisLine={false} tickLine={false} allowDecimals={false} width={44} />
            {phaseMarks(false)}
            <Tooltip
              cursor={{ stroke: CHART.axis, strokeDasharray: "2 2" }}
              content={<PointTooltip metric={(p) => `${p.rulesRepeat} aturan ulangi · ${p.rulesAvoid} aturan hindari`} />}
            />
            <Area type="stepAfter" dataKey="rulesRepeat" stackId="r" stroke={CHART.profit} fill={CHART.profit} fillOpacity={0.35} isAnimationActive={false} />
            <Area type="stepAfter" dataKey="rulesAvoid" stackId="r" stroke={CHART.loss} fill={CHART.loss} fillOpacity={0.35} isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      </ChartBlock>
      <div className="-mt-2 text-center text-[11px] text-text-tertiary">urutan posisi (1 = terlama)</div>
    </section>
  );
}
