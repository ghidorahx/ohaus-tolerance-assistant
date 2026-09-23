import { directSearchHealth, handleDirectSearch } from "@/lib/direct-search-handler.mjs";
export const runtime = "edge";
export function GET() { return directSearchHealth(process.env); }
export function POST(request: Request) { return handleDirectSearch(request, process.env); }
