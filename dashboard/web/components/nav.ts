import {
  SquaresFour,
  ChatCircle,
  ChartLineUp,
  GraduationCap,
  GitBranch,
  SlidersHorizontal,
  Prohibit,
  Wallet,
  Crosshair,
  TrendUp,
  Scroll,
  BookOpen,
  UsersThree,
} from "@phosphor-icons/react";
import type { Icon } from "@/lib/icon";

export interface NavItem {
  href: string;
  label: string;
  icon: Icon;
}

// Nav is filled in per milestone. Overview/Positions/Feed/Decisions are M1;
// Config/Blocklist are M2; Wallet/Screen are M3; Learning/Logs are M4.
export const NAV: NavItem[] = [
  { href: "/", label: "Overview", icon: SquaresFour },
  { href: "/chat", label: "Chat", icon: ChatCircle },
  { href: "/positions", label: "Positions", icon: ChartLineUp },
  { href: "/feed", label: "Feed", icon: GraduationCap },
  { href: "/decisions", label: "Decisions", icon: GitBranch },
  { href: "/config", label: "Config", icon: SlidersHorizontal },
  { href: "/blocklist", label: "Blocklist", icon: Prohibit },
  { href: "/wallet", label: "Wallet", icon: Wallet },
  { href: "/follow", label: "Follow", icon: UsersThree },
  { href: "/screen", label: "Screen", icon: Crosshair },
  { href: "/learning", label: "Learning", icon: TrendUp },
  { href: "/belajar", label: "Belajar", icon: BookOpen },
  { href: "/logs", label: "Logs", icon: Scroll },
];

export function titleForPath(pathname: string): string {
  if (pathname === "/") return "Overview";
  const item = NAV.find((n) => n.href !== "/" && pathname.startsWith(n.href));
  return item?.label ?? "Meridian";
}
