package main

import (
	"example.com/gosvc/internal/store"
	"github.com/gin-gonic/gin"
)

func handle(c *gin.Context) {
	s := store.Open()
	s.Add("x")
}

func main() {
	r := gin.Default()
	r.GET("/items", handle)
	r.Run()
}
