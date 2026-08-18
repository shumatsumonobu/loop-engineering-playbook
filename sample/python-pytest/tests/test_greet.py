from src.greet import greet


def test_greet_uses_the_name():
    assert greet("Ada") == "Hello, Ada!"


def test_greet_handles_empty_name():
    assert greet("") == "Hello, !"
