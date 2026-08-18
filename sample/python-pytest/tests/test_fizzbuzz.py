from src.fizzbuzz import fizzbuzz


def test_multiple_of_three_returns_fizz():
    assert fizzbuzz(3) == "Fizz"
    assert fizzbuzz(6) == "Fizz"
    assert fizzbuzz(9) == "Fizz"


def test_multiple_of_five_returns_buzz():
    assert fizzbuzz(5) == "Buzz"
    assert fizzbuzz(10) == "Buzz"
    assert fizzbuzz(20) == "Buzz"


def test_multiple_of_fifteen_returns_fizzbuzz():
    assert fizzbuzz(15) == "FizzBuzz"
    assert fizzbuzz(30) == "FizzBuzz"


def test_fifteen_takes_priority_over_fizz_and_buzz():
    # 15 は 3 の倍数でも 5 の倍数でもあるが 'FizzBuzz' が優先される
    assert fizzbuzz(15) == "FizzBuzz"
    assert fizzbuzz(45) == "FizzBuzz"


def test_non_multiple_returns_decimal_string():
    assert fizzbuzz(1) == "1"
    assert fizzbuzz(2) == "2"
    assert fizzbuzz(4) == "4"
    assert fizzbuzz(7) == "7"


def test_return_value_is_string_type():
    assert isinstance(fizzbuzz(1), str)
    assert isinstance(fizzbuzz(3), str)
    assert isinstance(fizzbuzz(5), str)
    assert isinstance(fizzbuzz(15), str)


def test_boundaries_one_and_two():
    assert fizzbuzz(1) == "1"
    assert fizzbuzz(2) == "2"


def test_zero_is_multiple_of_fifteen():
    # 0 は 3・5・15 いずれの倍数でもあるため 'FizzBuzz'
    assert fizzbuzz(0) == "FizzBuzz"


def test_negative_multiples():
    assert fizzbuzz(-3) == "Fizz"
    assert fizzbuzz(-5) == "Buzz"
    assert fizzbuzz(-15) == "FizzBuzz"


def test_negative_non_multiple_returns_decimal_string():
    assert fizzbuzz(-1) == "-1"
    assert fizzbuzz(-2) == "-2"
