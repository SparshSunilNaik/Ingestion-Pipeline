from flask import Flask, jsonify

from inv.service import make_service
from inv.storage import MemoryRepo

app = Flask(__name__)
repo = MemoryRepo()


@app.route("/items/<sku>", methods=["GET"])
def get_item(sku):
    service = make_service(repo)
    return jsonify(service.lookup(sku))


@app.route("/items", methods=["POST"])
def add_item():
    service = make_service(repo)
    return jsonify(service.register("new", 1))


def build_report(rows):
    formatter = rows.pop()
    return formatter.render()
