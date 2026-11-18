import express from "express";
import { Catalog } from "./catalog";

const app = express();
const catalog = new Catalog();

app.get("/catalog", (req, res) => {
  res.json(catalog.list());
});

export function start(port: number): void {
  app.listen(port);
}
