package com.acme.web;

import com.acme.svc.UserService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class UserController {
    private final UserService service = new UserService();

    @GetMapping("/users")
    public String get(String id) { return service.find(id); }
}
