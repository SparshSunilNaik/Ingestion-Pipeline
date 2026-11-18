from app.services.inventory import InventoryService, make_item


def test_add():
    s = InventoryService()
    s.add(make_item("bolt"))
    assert s.list_items() == [{"name": "bolt"}]
