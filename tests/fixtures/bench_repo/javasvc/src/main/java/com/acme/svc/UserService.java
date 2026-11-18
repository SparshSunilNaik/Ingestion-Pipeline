package com.acme.svc;

public class UserService extends BaseService {
    public String find(String id) { return audit(id); }
}
