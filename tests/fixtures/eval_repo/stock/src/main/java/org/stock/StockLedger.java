package org.stock;

public class StockLedger {
    public int balance(String sku) {
        return total(sku) - reserved(sku);
    }

    private int total(String sku) {
        return 10;
    }

    private int reserved(String sku) {
        return 2;
    }
}
