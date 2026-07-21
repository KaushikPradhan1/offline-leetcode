
class Solution:
    def sum_of_two_integers(self, a: int, b: int) -> int:
        """
        Calculates the sum of two integers without using + or - operators
        using Bitwise Operations (XOR & AND) with Python 32-bit mask handling.
        """
        # 32-bit mask to simulate 32-bit integer behavior in Python
        mask = 0xFFFFFFFF
        
        while b & mask:
            carry = (a & b) << 1
            a = a ^ b
            b = carry
            
        # Handle negative numbers in Python's arbitrary-precision integers
        return (a & mask) if b > 0 else a

sol = Solution()
try:
    res = sol.sum_of_two_integers([3, 3], 6)
    print(f"OUTPUT:{res}")
except Exception as e:
    print(f"ERROR:{e}")
