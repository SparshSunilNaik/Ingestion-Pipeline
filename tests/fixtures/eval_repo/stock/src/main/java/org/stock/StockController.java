package org.stock;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class StockController {
    private final StockLedger ledger;
    private final Clock clock = new Clock();

    public StockController(StockLedger ledger) {
        this.ledger = ledger;
    }

    @GetMapping("/stock/{sku}")
    public int level(@PathVariable String sku) {
        clock.tick();
        return ledger.balance(sku);
    }
}
