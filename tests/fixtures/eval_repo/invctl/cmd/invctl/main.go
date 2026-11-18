package main

import (
	"log"
	"net/http"

	"example.com/invctl/internal/server"
)

func main() {
	srv := server.New(":8080")
	http.HandleFunc("/health", srv.Health)
	log.Fatal(srv.Run())
}
