import { useState } from "react";
import { fetchItems, type Item } from "@/lib/api";

export default function Home() {
  const [items, setItems] = useState<Item[]>([]);
  fetchItems("/api").then(setItems);
  return <ul>{items.map((i) => <li key={i.name}>{i.name}</li>)}</ul>;
}
