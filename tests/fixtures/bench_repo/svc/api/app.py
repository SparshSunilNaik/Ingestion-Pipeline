from fastapi import FastAPI

from svc.core import Admin, login

app = FastAPI()


@app.post("/login")
def login_route(name: str, password: str) -> dict:
    return {"token": login(name, password)}


@app.get("/admin/{name}")
def admin_route(name: str) -> dict:
    admin = Admin(name)
    return {"label": admin.promote(), "dynamic": helper_factory().run()}


def helper_factory():
    return None


if __name__ == "__main__":
    login("root", "secret")
